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

type ValuationStatus = Extract<AgentEvent, { type: 'valuation' }>['status']

const VALUATION_LABEL: Record<ValuationStatus, string> = {
  ok: 'DCF fair value computed',
  multiples_only: 'multiples only',
  unavailable: 'unavailable',
}

// The api appends "; multiples-only (…)" to its reason, which the label already says.
function valuationReason(reason: string | null): string | null {
  const first = reason?.split(';')[0]?.trim().replace(/\.$/, '')
  return first ? `${first.charAt(0).toUpperCase()}${first.slice(1)}.` : null
}

// The api's node name for each debater, whose turn the debate panels show in full.
const DEBATE_NODE: Record<'bull' | 'bear', string> = {
  bull: 'Bull Researcher',
  bear: 'Bear Researcher',
}
const RISK_NODE: Record<RiskSpeaker, string> = {
  aggressive: 'Aggressive Analyst',
  conservative: 'Conservative Analyst',
  neutral: 'Neutral Analyst',
}
// The verdict card under the timeline shows the decision this node writes.
const DECISION_NODE = 'Risk Manager'
const PANEL_OF_NODE = new Map<string, 'debate' | 'risk-debate'>([
  ...Object.values(DEBATE_NODE).map(node => [node, 'debate'] as const),
  ...Object.values(RISK_NODE).map(node => [node, 'risk-debate'] as const),
])

type RenderItem =
  | ({ kind: 'node' } & NodeRecord)
  | ({ kind: 'debate' } & DebateRecord)
  | { kind: 'risk-debate'; turns: RiskTurn[] }
  | ({ kind: 'synthesis' } & SynthesisRecord)
  | ({ kind: 'valuation-veto' } & ValuationVetoRecord)
  | { kind: 'valuation'; label: string; reason: string | null }

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
    | { kind: 'valuation' }
  > = []
  // A resumed run reports its valuation again; the latest one stands.
  let valuation: { label: string; reason: string | null } | null = null
  const vetoRecords: ValuationVetoRecord[] = []
  // Nodes whose full text a debate panel or synthesis card shows.
  const shownInFull = new Set<string>()

  for (const ev of props.events) {
    if (ev.type === 'node-start') {
      const started = nodes.get(ev.node)
      // A debater starts again for each round it speaks in.
      if (started) started.state = 'running'
      else {
        nodes.set(ev.node, {
          node: ev.node,
          toolCalls: [],
          summary: null,
          report: null,
          state: 'running',
        })
        // The second debater starts after the first one's turn opened the
        // panel. Its card joins the first one's, above the panel.
        const panel = PANEL_OF_NODE.get(ev.node)
        const at = panel ? order.findIndex(o => o.kind === panel) : -1
        if (at === -1) order.push({ kind: 'node', node: ev.node })
        else order.splice(at, 0, { kind: 'node', node: ev.node })
      }
    }
    else if (ev.type === 'tool-call') {
      const n = nodes.get(ev.node)
      if (n) n.toolCalls.push({ tool: ev.tool, args: ev.args })
    }
    else if (ev.type === 'tool-result') {
      // A step sends several calls at once and their results follow in the same order.
      const tc = nodes.get(ev.node)?.toolCalls.find(c => c.tool === ev.tool && c.ok === undefined)
      if (tc) {
        tc.ok = ev.ok
        tc.preview = ev.preview
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
      shownInFull.add(DEBATE_NODE[ev.side])
    }
    else if (ev.type === 'risk-debate-turn') {
      if (riskTurns === null) {
        riskTurns = []
        order.push({ kind: 'risk-debate' })
      }
      riskTurns.push({ speaker: ev.speaker, text: ev.text, turn: ev.turn })
      shownInFull.add(RISK_NODE[ev.speaker])
    }
    else if (ev.type === 'synthesis') {
      shownInFull.add(ev.node)
      // The plan is the step's whole output, and runs stored before the api
      // reported these steps' ends have nothing else to finish them.
      const author = nodes.get(ev.node)
      if (author) author.state = 'done'
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
    else if (ev.type === 'decision') {
      shownInFull.add(DECISION_NODE)
    }
    else if (ev.type === 'valuation') {
      if (valuation === null) order.push({ kind: 'valuation' })
      valuation = { label: VALUATION_LABEL[ev.status], reason: valuationReason(ev.reason) }
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
    if (o.kind === 'node') {
      const node = nodes.get(o.node)!
      return { kind: 'node', ...node, summary: shownInFull.has(o.node) ? null : node.summary }
    }
    if (o.kind === 'debate')         return { kind: 'debate', ...debates.get(o.round)! }
    if (o.kind === 'risk-debate')    return { kind: 'risk-debate', turns: riskTurns ?? [] }
    if (o.kind === 'valuation-veto') return { kind: 'valuation-veto', ...vetoRecords[o.idx]! }
    if (o.kind === 'valuation')      return { kind: 'valuation', ...valuation! }
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
      <p
        v-else-if="item.kind === 'valuation'"
        class="valuation-state"
        data-testid="valuation-state"
      >
        <span class="valuation-state__label">Valuation:</span>
        {{ item.label }}.
        <template v-if="item.reason">{{ item.reason }}</template>
      </p>
      <div
        v-else-if="item.kind === 'valuation-veto'"
        class="valuation-veto-banner"
        role="alert"
      >
        <UIcon name="i-lucide-triangle-alert" class="veto-icon" aria-hidden="true" />
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

.valuation-state {
  margin: 0;
  padding: 0.6rem 1rem;
  border: 1px solid var(--ink-line);
  border-radius: var(--radius-card);
  color: var(--paper-2);
  font-size: 0.9rem;
  line-height: 1.4;
}
.valuation-state__label {
  color: var(--paper-1);
  font-weight: 600;
}

.valuation-veto-banner {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-radius: var(--radius-card);
  background-color: color-mix(in srgb, var(--accent) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  color: var(--paper-1);
  font-size: 0.9rem;
  line-height: 1.4;
}

.veto-icon {
  flex-shrink: 0;
  width: 1.1rem;
  height: 1.1rem;
  margin-top: 0.05rem;
  color: var(--accent);
}

.veto-rating {
  font-family: var(--font-mono);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
</style>
