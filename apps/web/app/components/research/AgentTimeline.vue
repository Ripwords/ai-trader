<script setup lang="ts">
import { computed } from 'vue'
import AgentStepCard from './AgentStepCard.vue'
import DebateRound from './DebateRound.vue'
import RiskDebatePanel from './RiskDebatePanel.vue'
import SynthesisCard from './SynthesisCard.vue'
import type { AgentEvent, RiskSpeaker, SynthesisStage } from '../../../types/agents'

interface Props {
  events: AgentEvent[]
}
const props = defineProps<Props>()

interface NodeRecord {
  node: string
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; ok?: boolean; preview?: string }>
  summary: string | null
  /** Full markdown report attached to this node (when available). Replaces
   *  the truncated ``summary`` in the expanded view of AgentStepCard. */
  report: string | null
  state: 'running' | 'done' | 'failed'
}

interface DebateRecord {
  round: number
  bull: string
  bear: string
}

interface RiskTurn {
  speaker: RiskSpeaker
  text: string
  turn: number
}

interface SynthesisRecord {
  stage: SynthesisStage
  node: string
  content: string
}

interface ValuationVetoRecord {
  original_rating: string
  effective_rating: string
  reason: string
  rating_cap: string
}

type RenderItem =
  | ({ kind: 'node' } & NodeRecord)
  | ({ kind: 'debate' } & DebateRecord)
  | { kind: 'risk-debate'; turns: RiskTurn[] }
  | ({ kind: 'synthesis' } & SynthesisRecord)
  | ({ kind: 'valuation-veto' } & ValuationVetoRecord)

// Aggregate the wire stream into renderable timeline items. Order is
// preserved by the *first* event that touches each item — node-start /
// debate-round / risk-debate-turn / synthesis. This keeps the visual
// chronology of the run intact even if later events update earlier items
// (e.g. an analyst's report lands after node-end).
const items = computed<RenderItem[]>(() => {
  const nodes = new Map<string, NodeRecord>()
  const debates = new Map<number, DebateRecord>()
  // The risk debate is rendered as a single panel of stacked turns rather
  // than per-turn entries in the timeline — that preserves its three-voice
  // dialogue character. We collect all turns under a single index.
  let riskTurns: RiskTurn[] | null = null
  // Synthesis cards are keyed by stage so re-emitted events update content
  // in place rather than producing duplicates.
  const synth = new Map<SynthesisStage, SynthesisRecord>()
  const order: Array<
    | { kind: 'node'; node: string }
    | { kind: 'debate'; round: number }
    | { kind: 'risk-debate' }
    | { kind: 'synthesis'; stage: SynthesisStage }
    | { kind: 'valuation-veto'; idx: number }
  > = []
  const vetoRecords: ValuationVetoRecord[] = []

  for (const ev of props.events) {
    if (ev.type === 'node-start') {
      if (!nodes.has(ev.node)) {
        nodes.set(ev.node, {
          node: ev.node,
          toolCalls: [],
          summary: null,
          report: null,
          state: 'running',
        })
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
    else if (ev.type === 'report') {
      // Find the node this report belongs to. The api emits ``node`` as
      // the same human-readable label we used for node-start, so a direct
      // lookup works. If the node-start event hasn't been seen yet (race
      // on backfill from history), we synthesise a node record.
      let n = nodes.get(ev.node)
      if (!n) {
        n = { node: ev.node, toolCalls: [], summary: null, report: null, state: 'done' }
        nodes.set(ev.node, n)
        order.push({ kind: 'node', node: ev.node })
      }
      n.report = ev.content
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
    else if (ev.type === 'risk-debate-turn') {
      if (riskTurns === null) {
        riskTurns = []
        order.push({ kind: 'risk-debate' })
      }
      riskTurns.push({ speaker: ev.speaker, text: ev.text, turn: ev.turn })
    }
    else if (ev.type === 'synthesis') {
      const existing = synth.get(ev.stage)
      if (existing) {
        existing.content = ev.content
        existing.node = ev.node
      }
      else {
        synth.set(ev.stage, { stage: ev.stage, node: ev.node, content: ev.content })
        order.push({ kind: 'synthesis', stage: ev.stage })
      }
    }
    else if (ev.type === 'valuation-veto') {
      const idx = vetoRecords.length
      vetoRecords.push({
        original_rating: ev.original_rating,
        effective_rating: ev.effective_rating,
        reason: ev.reason,
        rating_cap: ev.rating_cap,
      })
      order.push({ kind: 'valuation-veto', idx })
    }
    else if (ev.type === 'error') {
      if (ev.node) {
        const n = nodes.get(ev.node)
        if (n) n.state = 'failed'
      }
    }
  }

  return order.map((o): RenderItem => {
    if (o.kind === 'node')           return { kind: 'node', ...nodes.get(o.node)! }
    if (o.kind === 'debate')         return { kind: 'debate', ...debates.get(o.round)! }
    if (o.kind === 'risk-debate')    return { kind: 'risk-debate', turns: riskTurns ?? [] }
    if (o.kind === 'valuation-veto') return { kind: 'valuation-veto', ...vetoRecords[o.idx]! }
    return { kind: 'synthesis', ...synth.get(o.stage)! }
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
      <RiskDebatePanel
        v-else-if="item.kind === 'risk-debate'"
        :turns="item.turns"
      />
      <SynthesisCard
        v-else-if="item.kind === 'synthesis'"
        :stage="item.stage"
        :node="item.node"
        :content="item.content"
      />
      <div
        v-else-if="item.kind === 'valuation-veto'"
        class="valuation-veto-banner"
        role="alert"
      >
        <span class="veto-icon">⚠</span>
        <span class="veto-text">
          <strong>Valuation veto applied</strong> — rating capped from
          <span class="veto-rating">{{ item.original_rating }}</span> to
          <span class="veto-rating">{{ item.effective_rating }}</span>:
          {{ item.reason }}
        </span>
      </div>
      <AgentStepCard
        v-else
        :node="item.node"
        :tool-calls="item.toolCalls"
        :summary="item.summary"
        :state="item.state"
        :report="item.report"
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

.valuation-veto-banner {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
  background-color: #fff3cd;
  border: 1px solid #ffc107;
  color: #664d03;
  font-size: 0.9rem;
  line-height: 1.4;
}

.veto-icon {
  flex-shrink: 0;
  font-size: 1.1rem;
  margin-top: 0.05rem;
}

.veto-rating {
  font-family: monospace;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
</style>
