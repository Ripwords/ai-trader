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

const {
  events, status, verdict, runId, error, startedAt,
  start, resume, cancel, loadFromHistory, reset,
} = useAgentsRun()
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

// Most-recent ``running`` row for this symbol, if any. Used by the
// breadcrumb pill so the user always knows there's a live run in flight
// (across browser tabs / refreshes) even if the local composable hasn't
// hooked into it yet. The composable's status drives the in-page run
// surface; this is the global "for this symbol" signal.
const liveRun = computed(() => {
  for (const r of historyRows.value) {
    if (r.status === 'running') return r
  }
  return null
})

const costSamples = computed(() =>
  historyRows.value.map(r => ({ costUsd: r.costUsd })),
)

// ────── Running-state progress UX ──────
// The first analyst can take 15-30s to finish its report; without surfacing
// per-tool / per-node activity the page reads as "stuck on running…". Show
// elapsed seconds + the latest concrete activity so the banner can show
// "Fundamentals Analyst · get_balance_sheet · 12s" instead of just a dot.
//
// Anchor to the run's actual ``started_at`` (sourced from agent_runs by the
// composable on history-replay) rather than ``Date.now()`` at status flip,
// so a refreshed page shows the cumulative elapsed time, not a re-zeroed
// counter.
const elapsedSec = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null

function recomputeElapsed() {
  if (startedAt.value === null) {
    elapsedSec.value = 0
    return
  }
  elapsedSec.value = Math.max(0, Math.floor((Date.now() - startedAt.value.getTime()) / 1000))
}

watch([status, startedAt], ([s]) => {
  if (s === 'running') {
    recomputeElapsed()
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = setInterval(recomputeElapsed, 1000)
  }
  else {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    recomputeElapsed()
  }
}, { immediate: true })

interface StartOpts {
  max_debate_rounds: number
  max_risk_discuss_rounds: number
  deep_thinking: boolean
  reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  response_language: 'en-US' | 'zh-TW' | 'zh-CN' | 'ja-JP' | 'ko-KR' | 'de-DE'
  selected_analysts: string[]
}

/**
 * Cancel an in-flight run that the user can see is alive (via the
 * breadcrumb pill or the RunCostEstimate banner) but hasn't deep-linked
 * into. Hits the same DELETE endpoint the run-view's cancel button uses,
 * then refreshes history so the row flips to ``cancelled`` in the UI.
 */
async function onCancelInFlight(targetRunId: string) {
  try {
    await fetch(
      `/api/research/agents-run?run_id=${encodeURIComponent(targetRunId)}`,
      { method: 'DELETE' },
    )
  }
  catch {
    /* server error — DB row is still in 'running'; refresh below
       so the user can see what state we're actually in. */
  }
  void refreshHistory()
}

function onStart(opts: StartOpts) {
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
  async (id, prev) => {
    if (id === prev) return

    // Transition to NO ?run= — user clicked the symbol breadcrumb (or
    // the URL was otherwise cleared). Drop composable state back to
    // idle so the page re-renders the RunCostEstimate / history surface
    // instead of staying stuck on the previously-loaded run's events.
    // Also re-fetch history so any runs that completed since the last
    // visit are visible.
    if (!id) {
      reset()
      void refreshHistory()
      return
    }

    // Already showing this run live — no replay needed.
    if (id === runId.value && events.value.length > 0) return

    await loadFromHistory(id)

    // ``loadFromHistory`` resets to ``idle`` (composable-side) when the
    // run doesn't exist anymore — typically a stale URL from a prior DB
    // state. Strip the ``?run=`` so subsequent refreshes don't keep
    // hitting the same dead lookup and surfacing 404s in the console.
    if (status.value === 'idle' && runId.value === null) {
      const { run: _drop, ...rest } = route.query
      void router.replace({ query: rest })
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="page-header">
      <!-- Breadcrumb: ``research`` exits to the index, the symbol exits the
           current ?run=<id> deep-link back to the symbol's main view. Both
           segments are clickable; ``aria-current`` marks the active leaf
           when no specific run is being viewed. -->
      <nav class="crumb" aria-label="breadcrumb">
        <NuxtLink to="/research" class="crumb__link crumb__research">
          research
        </NuxtLink>
        <span class="crumb__sep" aria-hidden="true">/</span>
        <NuxtLink
          :to="{ path: `/research/${symbol}`, query: {} }"
          class="crumb__link crumb__symbol"
          :aria-current="!queryRunId ? 'page' : undefined"
          data-mono
        >
          {{ symbol }}
        </NuxtLink>

        <!-- Pills: live-run indicator when *any* run is in-flight for this
             symbol; specific-run indicator when the URL has ?run=<id>. -->
        <span
          v-if="liveRun && liveRun.id !== queryRunId"
          class="crumb__pill crumb__pill--live"
          data-mono
          :title="`run started ${liveRun.startedAt ?? ''}`"
        >
          <span class="crumb__beacon" /> live run
        </span>
        <span
          v-if="queryRunId"
          class="crumb__pill crumb__pill--specific"
          data-mono
          :title="`viewing run ${queryRunId}`"
        >
          run · {{ queryRunId.slice(0, 8) }}
        </span>
      </nav>

      <div class="page-header__actions">
        <NuxtLink :to="`/research/report/${symbol}`" class="page-header__link">
          risk report →
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden research-main">
      <RunHeader
        :status="status"
        :events="events"
        :elapsed-sec="elapsedSec"
        :symbol="symbol"
        :run-id="runId"
        @cancel="cancel"
      />

      <div class="research-shell">
        <!-- ─── PRIMARY column: the run itself ─── -->
        <div class="research-primary">
          <!-- Resume hint for ?run=<failed-id> deep-links. -->
          <section
            v-if="canResume"
            class="resume-card"
            data-testid="agent-resume-banner"
          >
            <header class="resume-card__head">
              <span class="resume-card__eyebrow">
                <span class="resume-card__dot" />
                run halted
              </span>
              <span class="resume-card__id" data-mono>
                run · {{ targetedRun?.id?.slice(0, 8) }}
              </span>
            </header>
            <p class="resume-card__error" data-mono>
              {{ targetedRun?.error ?? 'unknown error' }}
            </p>
            <button
              type="button"
              class="resume-card__btn"
              data-testid="agent-resume-button"
              @click="onResume"
            >
              <span data-mono>resume from checkpoint</span>
              <span class="resume-card__btn-glyph" data-mono>↻</span>
            </button>
          </section>

          <RunCostEstimate
            v-if="status === 'idle' && !canResume"
            :symbol="symbol"
            :run-history="costSamples"
            :in-flight="!!liveRun"
            :in-flight-run-id="liveRun?.id ?? null"
            @start="onStart"
            @cancel-in-flight="onCancelInFlight"
          />

          <!-- Empty state inside an active run before any events arrive
               (~1s window). Reads as a transmission test pattern. -->
          <section
            v-if="status === 'running' && events.length === 0"
            class="warmup"
            aria-live="polite"
          >
            <div class="warmup__bars" aria-hidden="true">
              <span /><span /><span /><span /><span />
            </div>
            <p class="warmup__text" data-mono>
              opening graph · seeding memory · binding tools
            </p>
          </section>

          <AgentTimeline
            v-if="events.length > 0"
            :events="events"
            class="timeline"
          />

          <AgentVerdict
            v-if="verdict"
            :rating="verdict.rating"
            :confidence="verdict.confidence"
            :rationale="verdict.rationale"
            :run-id="runId"
          />

          <section
            v-if="error && status === 'failed'"
            class="error-card"
            role="alert"
          >
            <header class="error-card__head">
              <span class="error-card__eyebrow">transmission failed</span>
            </header>
            <p class="error-card__body" data-mono>{{ error }}</p>
          </section>
        </div>

        <!-- ─── SECONDARY column: history. Quieter, smaller. ─── -->
        <aside class="research-secondary">
          <header class="aside-head">
            <span class="aside-head__eyebrow">recent runs</span>
            <span class="aside-head__count" data-mono>
              {{ historyRows.length }}
            </span>
          </header>
          <RunHistoryTable :rows="historyRows" />
        </aside>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* ─── Page header / breadcrumb ─── */
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  height: 4rem;
  padding: 0 1.75rem;
  border-bottom: 1px solid var(--ink-line);
  flex-shrink: 0;
}

.crumb {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  flex-wrap: wrap;
  min-width: 0;
}
.crumb__link {
  color: var(--paper-3);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  padding-bottom: 1px;
  transition: color 140ms ease, border-color 140ms ease;
}
.crumb__link:hover { color: var(--accent); border-bottom-color: var(--accent); }
.crumb__symbol {
  color: var(--paper-1);
  letter-spacing: 0.06em;
}
.crumb__symbol[aria-current="page"] {
  /* Active leaf — visually the heaviest segment but still clickable
     (clicking on the active symbol is a no-op refresh, which is fine). */
  color: var(--paper-0);
  cursor: default;
}
.crumb__sep { color: var(--ink-line-strong); }

.crumb__pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.18rem 0.55rem;
  border-radius: 2px;
  border: 1px solid var(--ink-line-strong);
  font-size: 0.62rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  background: var(--ink-2);
}
.crumb__pill--live {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
}
.crumb__pill--specific {
  color: var(--paper-1);
  background: var(--ink-2);
}
.crumb__beacon {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 rgba(212, 169, 106, 0.5);
  animation: crumb-beacon 1.4s ease-out infinite;
}
@keyframes crumb-beacon {
  0%   { box-shadow: 0 0 0 0 rgba(212, 169, 106, 0.55); }
  70%  { box-shadow: 0 0 0 5px rgba(212, 169, 106, 0); }
  100% { box-shadow: 0 0 0 0 rgba(212, 169, 106, 0); }
}

.page-header__actions {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-shrink: 0;
}
.page-header__link {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  text-decoration: none;
  transition: color 140ms ease;
}
.page-header__link:hover { color: var(--accent); }

/* ─── Layout: a generous editorial column for the active run, with a
   smaller history aside. The run is the page; history sits beside,
   not below, so the user always knows where to look back. ─── */
.research-main {
  background:
    radial-gradient(
      ellipse at top,
      rgba(212, 169, 106, 0.025) 0%,
      transparent 55%
    ),
    var(--ink-0);
}

.research-shell {
  max-width: 1240px;
  margin: 0 auto;
  padding: 1.5rem 1.5rem 4rem;
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 2.5rem;
}
@media (max-width: 980px) {
  .research-shell {
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }
}

.research-primary {
  display: flex;
  flex-direction: column;
  gap: 1.4rem;
  min-width: 0;
}

.research-secondary {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  min-width: 0;
}
.aside-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 0.2rem 0.4rem;
  border-bottom: 1px solid var(--ink-line);
}
.aside-head__eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.aside-head__count {
  font-size: 0.7rem;
  color: var(--paper-3);
  font-variant-numeric: tabular-nums;
}

/* ─── Resume card ─── */
.resume-card {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1rem 1.2rem;
  background: var(--ink-1);
  border: 1px solid var(--ink-line-strong);
  border-left: 3px solid var(--tape-down);
  border-radius: 3px;
}
.resume-card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.resume-card__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--tape-down);
}
.resume-card__dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--tape-down);
}
.resume-card__id {
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  color: var(--paper-3);
  text-transform: uppercase;
}
.resume-card__error {
  margin: 0;
  font-size: 0.78rem;
  color: var(--paper-2);
  line-height: 1.5;
  word-break: break-word;
}
.resume-card__btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.5rem 0.95rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-1);
  background: transparent;
  border: 1px solid var(--ink-line-strong);
  border-radius: 3px;
  cursor: pointer;
  transition: color 160ms ease, border-color 160ms ease;
}
.resume-card__btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.resume-card__btn-glyph {
  font-size: 0.85rem;
  line-height: 1;
}

/* ─── Warm-up state ─── */
.warmup {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.1rem;
  padding: 2rem 1rem;
}
.warmup__bars {
  display: flex;
  align-items: flex-end;
  gap: 5px;
  height: 32px;
}
.warmup__bars span {
  display: block;
  width: 3px;
  background: var(--accent);
  border-radius: 1px;
  animation: warmup-bar 1.1s ease-in-out infinite;
}
.warmup__bars span:nth-child(1) { animation-delay: 0.0s; height: 60%; }
.warmup__bars span:nth-child(2) { animation-delay: 0.1s; height: 80%; }
.warmup__bars span:nth-child(3) { animation-delay: 0.2s; height: 100%; }
.warmup__bars span:nth-child(4) { animation-delay: 0.3s; height: 75%; }
.warmup__bars span:nth-child(5) { animation-delay: 0.4s; height: 50%; }
@keyframes warmup-bar {
  0%, 100% { transform: scaleY(0.4); opacity: 0.45; }
  50% { transform: scaleY(1); opacity: 1; }
}
.warmup__text {
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
}

/* ─── Timeline wrapper ─── */
.timeline {
  border: 1px solid var(--ink-line);
  border-radius: 3px;
  background: var(--ink-1);
  /* The first card's top border is provided by .step__head, and the
     timeline wrapper supplies the outer frame. Keeps the seam clean. */
  overflow: hidden;
}

/* ─── Error card ─── */
.error-card {
  padding: 1rem 1.2rem;
  background: rgba(224, 122, 95, 0.04);
  border: 1px solid rgba(224, 122, 95, 0.25);
  border-radius: 3px;
}
.error-card__head { margin-bottom: 0.4rem; }
.error-card__eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--tape-down);
}
.error-card__body {
  margin: 0;
  font-size: 0.78rem;
  color: var(--paper-1);
  line-height: 1.55;
  word-break: break-word;
}
</style>
