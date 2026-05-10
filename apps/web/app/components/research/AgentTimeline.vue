<script setup lang="ts">
import { computed } from 'vue'
import AgentStepCard from './AgentStepCard.vue'
import DebateRound from './DebateRound.vue'
import type { AgentEvent } from '../../../types/agents'

interface Props {
  events: AgentEvent[]
}
const props = defineProps<Props>()

interface NodeRecord {
  node: string
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; ok?: boolean; preview?: string }>
  summary: string | null
  state: 'running' | 'done' | 'failed'
}

interface DebateRecord {
  round: number
  bull: string
  bear: string
}

type RenderItem =
  | ({ kind: 'node' } & NodeRecord)
  | ({ kind: 'debate' } & DebateRecord)

const items = computed<RenderItem[]>(() => {
  const nodes = new Map<string, NodeRecord>()
  const debates = new Map<number, DebateRecord>()
  const order: Array<{ kind: 'node'; node: string } | { kind: 'debate'; round: number }> = []

  for (const ev of props.events) {
    if (ev.type === 'node-start') {
      if (!nodes.has(ev.node)) {
        nodes.set(ev.node, { node: ev.node, toolCalls: [], summary: null, state: 'running' })
        order.push({ kind: 'node', node: ev.node })
      }
    }
    else if (ev.type === 'tool-call') {
      const n = nodes.get(ev.node)
      if (n) n.toolCalls.push({ tool: ev.tool, args: ev.args })
    }
    else if (ev.type === 'tool-result') {
      const n = nodes.get(ev.node)
      if (n) {
        const tc = n.toolCalls[n.toolCalls.length - 1]
        if (tc && tc.tool === ev.tool) {
          tc.ok = ev.ok
          tc.preview = ev.preview
        }
      }
    }
    else if (ev.type === 'node-end') {
      const n = nodes.get(ev.node)
      if (n) {
        n.summary = ev.summary
        n.state = 'done'
      }
    }
    else if (ev.type === 'debate-round') {
      let d = debates.get(ev.round)
      if (!d) {
        d = { round: ev.round, bull: '', bear: '' }
        debates.set(ev.round, d)
        order.push({ kind: 'debate', round: ev.round })
      }
      if (ev.side === 'bull') d.bull = ev.text
      else d.bear = ev.text
    }
    else if (ev.type === 'error') {
      if (ev.node) {
        const n = nodes.get(ev.node)
        if (n) n.state = 'failed'
      }
    }
  }

  return order.map((o): RenderItem => {
    if (o.kind === 'node') return { kind: 'node', ...nodes.get(o.node)! }
    return { kind: 'debate', ...debates.get(o.round)! }
  })
})
</script>

<template>
  <div class="agent-timeline">
    <template v-for="(item, idx) in items" :key="idx">
      <DebateRound
        v-if="item.kind === 'debate'"
        :round="item.round"
        :bull="item.bull"
        :bear="item.bear"
      />
      <AgentStepCard
        v-else
        :node="item.node"
        :tool-calls="item.toolCalls"
        :summary="item.summary"
        :state="item.state"
      />
    </template>
  </div>
</template>

<style scoped>
.agent-timeline {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
</style>
