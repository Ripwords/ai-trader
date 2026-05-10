<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAgentsRun } from '../../../composables/useAgentsRun'

definePageMeta({ section: 'research' })

interface AgentRunRow {
  id: string
  symbol: string
  tradeDate: string
  status: string
  rating: string | null
  confidence: number | null
  alpha: string | null
  outcome: string | null
  costUsd: string | null
  startedAt: string
  finishedAt: string | null
  error?: string | null
}

const route = useRoute()
const symbol = computed(() => decodeURIComponent(String(route.params.symbol)).toUpperCase())
// ``?run=<id>`` deep-links the page to a specific previous run so we can
// surface a Resume button when that run failed mid-flight (Task 8).
const queryRunId = computed(() => {
  const raw = route.query.run
  return typeof raw === 'string' && raw.length > 0 ? raw : null
})

useHead({ title: () => `research · ${symbol.value}` })

const { events, status, verdict, runId, error, start, resume, cancel, loadFromHistory } = useAgentsRun()
const router = useRouter()

const { data: runHistory, refresh: refreshHistory } = await useFetch<{ rows: AgentRunRow[] }>('/api/research/agent-runs', {
  query: { symbol },
  default: () => ({ rows: [] }),
})

// Separate fetch for the deep-linked run; ``useFetch`` keys cache by URL so
// scoping with ``?run_id=`` keeps it independent of the symbol-level history.
const { data: deepRun } = await useFetch<{ rows: AgentRunRow[] }>('/api/research/agent-runs', {
  query: { run_id: queryRunId },
  default: () => ({ rows: [] }),
  // Don't fire when the query param is absent — the empty-string id would
  // round-trip back as a no-op but adds a wasted request.
  immediate: queryRunId.value !== null,
})

const targetedRun = computed(() => deepRun.value?.rows?.[0] ?? null)
const canResume = computed(() => {
  const r = targetedRun.value
  return r !== null && r.status === 'failed' && status.value !== 'running'
})

const historyRows = computed(() =>
  (runHistory.value?.rows ?? []).map(r => ({
    ...r,
    costUsd: r.costUsd === null || r.costUsd === undefined ? null : Number(r.costUsd),
  })),
)

const costSamples = computed(() =>
  historyRows.value.map(r => ({ costUsd: r.costUsd })),
)

// ────── Running-state progress UX ──────
// The first analyst can take 15-30s to finish its report; without surfacing
// per-tool / per-node activity the page reads as "stuck on running…". Track
// elapsed seconds + the latest concrete activity so the banner can show
// "Fundamentals Analyst · get_balance_sheet · 12s" instead of just a dot.
const startedAt = ref<number | null>(null)
const elapsedSec = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null

watch(status, (s) => {
  if (s === 'running') {
    startedAt.value = Date.now()
    elapsedSec.value = 0
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = setInterval(() => {
      if (startedAt.value !== null) {
        elapsedSec.value = Math.floor((Date.now() - startedAt.value) / 1000)
      }
    }, 1000)
  }
  else if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
})

const lastToolEvent = computed(() => {
  for (let i = events.value.length - 1; i >= 0; i--) {
    const ev = events.value[i]
    if (ev.type === 'tool-call' || ev.type === 'tool-result') return ev
  }
  return null
})

const lastNodeStart = computed(() => {
  for (let i = events.value.length - 1; i >= 0; i--) {
    const ev = events.value[i]
    if (ev.type === 'node-start') return ev
  }
  return null
})

const progressMessage = computed(() => {
  const tool = lastToolEvent.value
  const node = lastNodeStart.value
  if (tool) {
    const verb = tool.type === 'tool-call' ? 'calling' : 'received'
    const nodeLabel = node ? node.node.replace(/_/g, ' ') + ' · ' : ''
    return `${nodeLabel}${verb} ${tool.tool}`
  }
  if (node) return `${node.node.replace(/_/g, ' ')} · thinking`
  if (events.value.length === 0) return 'spinning up agents…'
  return 'thinking'
})

function onStart(opts: { max_debate_rounds: number; deep_thinking: boolean }) {
  void start(symbol.value, opts).then(() => {
    void refreshHistory()
  })
}

function onResume() {
  const id = targetedRun.value?.id
  if (!id) return
  void resume(id).then(() => {
    void refreshHistory()
  })
}

// ────── Refresh-survival ──────
// Two pieces work together so a page reload doesn't lose the run:
//
// 1. When a fresh run starts, the first ``run-start`` event populates
//    ``runId``; we mirror that into the URL as ``?run=<id>`` (replace, not
//    push, so back-button keeps working). Any subsequent reload lands on the
//    same URL and triggers piece 2.
//
// 2. On mount with ``?run=<id>``, we replay the persisted event log from
//    ``agent_messages``. If the server-side run is still ``running``, the
//    composable starts a 2s poll for incremental events — a stand-in for
//    reconnecting to the original NDJSON stream, which HTTP doesn't allow
//    across page contexts.
watch(runId, (id) => {
  if (!id) return
  if (route.query.run === id) return
  void router.replace({ query: { ...route.query, run: id } })
})

// Trigger loadFromHistory on initial mount AND on every later
// ?run=<id> query change. Same-page navigation (clicking a row in
// RunHistoryTable when already on this page) only updates the query
// param — the [symbol].vue component doesn't unmount, so onMounted
// alone wouldn't refire and the composable's state would stay frozen
// on whatever the previous run rendered.
watch(
  queryRunId,
  (id, prev) => {
    if (!id) return
    if (id === prev) return
    if (id === runId.value && events.value.length > 0) return
    void loadFromHistory(id)
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research</span>
        <span class="font-mono text-xs text-[var(--paper-3)]">/</span>
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-1)]" data-mono>{{ symbol }}</span>
      </div>
      <div class="flex items-center gap-5">
        <NuxtLink
          :to="`/research/report/${symbol}`"
          class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]"
        >
          risk report →
        </NuxtLink>
        <NuxtLink
          to="/research"
          class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]"
        >
          ← research
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-5xl mx-auto px-7 py-8 space-y-6">
        <div
          v-if="canResume"
          class="surface-1 px-5 py-4 rounded-md flex items-center justify-between gap-4"
          data-testid="agent-resume-banner"
        >
          <div class="flex flex-col gap-1">
            <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--tape-down)]">
              previous run failed
            </span>
            <span class="font-mono text-[11px] text-[var(--paper-3)]">
              {{ targetedRun?.error ?? 'unknown error' }}
            </span>
          </div>
          <button
            type="button"
            class="font-mono text-xs uppercase tracking-[0.18em] px-3 py-1.5 border border-[var(--ink-line)] rounded text-[var(--paper-1)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-colors"
            data-testid="agent-resume-button"
            @click="onResume"
          >
            resume run
          </button>
        </div>

        <RunCostEstimate
          v-if="status === 'idle' && !canResume"
          :symbol="symbol"
          :run-history="costSamples"
          @start="onStart"
        />

        <div v-if="status === 'running'" class="flex items-center justify-between gap-4 surface-1 px-5 py-3 rounded-md">
          <div class="flex items-baseline gap-3 min-w-0">
            <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--accent)] running-dot shrink-0">
              ●
            </span>
            <span class="font-mono text-xs lowercase tracking-[0.06em] text-[var(--paper-1)] truncate">
              {{ progressMessage }}
            </span>
            <span class="font-mono text-xs text-[var(--paper-3)] tabular-nums shrink-0">
              {{ elapsedSec }}s · {{ events.length }} event{{ events.length === 1 ? '' : 's' }}
            </span>
          </div>
          <button
            type="button"
            class="font-mono text-xs uppercase tracking-[0.18em] px-3 py-1.5 border border-[var(--ink-line)] rounded text-[var(--paper-3)] hover:text-[var(--tape-down)] hover:border-[var(--tape-down)] transition-colors shrink-0"
            @click="cancel"
          >
            cancel run
          </button>
        </div>

        <AgentTimeline v-if="events.length > 0" :events="events" />

        <AgentVerdict
          v-if="verdict"
          :rating="verdict.rating"
          :confidence="verdict.confidence"
          :rationale="verdict.rationale"
          :run-id="runId"
        />

        <div
          v-if="error"
          class="surface-1 px-5 py-4 rounded-md font-mono text-sm text-[var(--tape-down)]"
        >
          {{ error }}
        </div>

        <RunHistoryTable :rows="historyRows" />
      </div>
    </main>
  </div>
</template>

<style scoped>
.running-dot {
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
