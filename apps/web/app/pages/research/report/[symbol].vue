<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useEventSource } from '@vueuse/core'
import type {
  ChartMarker,
  PriceBar,
  QuarterlyRow,
  RiskCardTone,
  RiskPillar,
  RiskRating,
  RiskReport,
  RiskReportEvent,
} from '../../../../types/research'

definePageMeta({ section: 'research' })

const route = useRoute()
const symbol = computed(() => decodeURIComponent(route.params.symbol as string))

useHead({ title: () => `risk report · ${symbol.value}` })

// Each section binds to a piece of this state. When a piece is null the
// section renders a skeleton instead of the real component.
interface ReportState {
  symbol: string
  name: string | null
  cached: boolean
  generated_at: string | null
  price: { last: number | null, change: number | null, change_pct: number | null, currency: string } | null
  bars: PriceBar[] | null
  markers: ChartMarker[]
  kpis: { label: string, value: string, tone: RiskCardTone }[] | null
  valuation: RiskPillar | null
  health: RiskPillar | null
  growth: RiskPillar | null
  risk_score: number | null
  quarterly: QuarterlyRow[] | null
  earnings_update: RiskReport['earnings_update']
  catalysts: string[] | null
  risks: string[] | null
  bottom_line: string | null
  rating: RiskRating | null
}

function emptyState(sym: string): ReportState {
  return {
    symbol: sym,
    name: null,
    cached: false,
    generated_at: null,
    price: null,
    bars: null,
    markers: [],
    kpis: null,
    valuation: null,
    health: null,
    growth: null,
    risk_score: null,
    quarterly: null,
    earnings_update: null,
    catalysts: null,
    risks: null,
    bottom_line: null,
    rating: null,
  }
}

const state = shallowRef<ReportState>(emptyState(symbol.value))
const phase = ref<'connecting' | 'streaming' | 'done' | 'error'>('connecting')
const errorMessage = ref<string | null>(null)
const refreshKey = ref(0)

const STREAM_EVENTS = ['cached', 'meta', 'price', 'chart', 'fundamentals', 'llm', 'done', 'error', 'ping'] as const

const url = computed(() => {
  const p = new URLSearchParams({ symbol: symbol.value })
  if (refreshKey.value > 0) p.set('refresh', '1')
  return `/api/research/deep-report-stream?${p.toString()}`
})

const { event, data, status, close, open, error: streamError } = useEventSource(
  url,
  STREAM_EVENTS as unknown as string[],
  { immediate: true, autoReconnect: false },
)

watch(status, (s) => {
  if (s === 'CLOSED' && phase.value === 'streaming') phase.value = 'done'
  if (s === 'OPEN' && phase.value === 'connecting') phase.value = 'streaming'
})

// A non-200 (expired session, api down) never reaches OPEN, so the phase
// stayed 'connecting' with a spinner and no retry button.
watch(streamError, (err) => {
  if (!err || phase.value === 'done') return
  phase.value = 'error'
  errorMessage.value ??= 'report stream failed to connect'
})

watch([event, data], ([ev, dat]) => {
  if (!ev || dat == null) return
  let payload: RiskReportEvent | null = null
  try {
    payload = JSON.parse(dat as string) as RiskReportEvent
  } catch {
    return
  }
  if (!payload) return

  // Replace state shallowly per event so reactivity flushes once per piece.
  const next: ReportState = { ...state.value }

  switch (payload.kind) {
    case 'cached': {
      const r = payload.report
      Object.assign(next, {
        symbol: r.symbol,
        name: r.name,
        cached: true,
        generated_at: r.generated_at,
        price: r.price,
        bars: r.chart.bars,
        markers: r.chart.markers,
        kpis: r.kpis,
        valuation: r.valuation,
        health: r.health,
        growth: r.growth,
        risk_score: r.risk_score,
        quarterly: r.quarterly,
        earnings_update: r.earnings_update,
        catalysts: r.catalysts,
        risks: r.risks,
        bottom_line: r.bottom_line,
        rating: r.rating,
      })
      phase.value = 'done'
      break
    }
    case 'meta':
      next.symbol = payload.symbol
      next.name = payload.name
      break
    case 'price':
      next.price = payload.price
      break
    case 'chart':
      next.bars = payload.bars
      break
    case 'fundamentals':
      next.quarterly = payload.quarterly
      next.earnings_update = payload.earnings_update
      break
    case 'llm':
      next.kpis = payload.kpis
      next.valuation = payload.valuation
      next.health = payload.health
      next.growth = payload.growth
      next.markers = payload.markers
      next.catalysts = payload.catalysts
      next.risks = payload.risks
      next.bottom_line = payload.bottom_line
      next.rating = payload.rating
      break
    case 'done':
      next.risk_score = payload.risk_score
      next.generated_at = payload.generated_at
      phase.value = 'done'
      close()
      break
    case 'error':
      errorMessage.value = payload.message
      if (payload.fatal) {
        phase.value = 'error'
        close()
      }
      break
  }
  state.value = next
})

function regenerate() {
  close()
  state.value = emptyState(symbol.value)
  phase.value = 'connecting'
  errorMessage.value = null
  refreshKey.value++
  // useEventSource reacts to URL changes, but force-open in case it's already
  // closed.
  open()
}

onUnmounted(() => close())

const showLoadingScreen = computed(() => {
  // Only show the full-screen loader before any section has hydrated.
  return state.value.price === null && state.value.bars === null && phase.value !== 'error'
})
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research</span>
        <span class="font-mono text-xs text-[var(--paper-3)]">/</span>
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-1)]" data-mono>{{ symbol }}</span>
        <span class="font-mono text-xs text-[var(--paper-3)]">/</span>
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-1)]">risk report</span>
        <span v-if="phase === 'streaming'" class="streaming-tag">streaming<span class="dots"><span>.</span><span>.</span><span>.</span></span></span>
        <span v-else-if="state.cached" class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)]">cached</span>
      </div>
      <div class="flex items-center gap-5">
        <button
          v-if="phase === 'done' || phase === 'error'"
          type="button"
          class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]"
          @click="regenerate"
        >
          regenerate ↻
        </button>
        <NuxtLink
          to="/research"
          class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]"
        >
          ← research
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div v-if="showLoadingScreen" class="loading">
        <div class="ring"><span /><span /><span /></div>
        <p>connecting · waiting on the first sections to arrive…</p>
      </div>

      <div v-else-if="phase === 'error' && errorMessage" class="errorbox">
        <div class="mark">!</div>
        <p>{{ errorMessage }}</p>
        <button type="button" class="retry" @click="regenerate">retry</button>
      </div>

      <div v-else data-risk-report class="report">
        <!-- Header — paints as soon as snapshot lands -->
        <PriceHeader
          v-if="state.price"
          :symbol="state.symbol"
          :name="state.name"
          :last="state.price.last"
          :change="state.price.change"
          :change-pct="state.price.change_pct"
          :currency="state.price.currency"
          :generated-at="state.generated_at ?? new Date().toISOString()"
          :cached="state.cached"
        />
        <div v-else class="skel header-skel surface-1">
          <div class="skel-bar" style="width: 10rem; height: 1.6rem" />
          <div class="skel-bar" style="width: 14rem; height: 1.6rem; margin-left: auto" />
        </div>

        <!-- Gauge + bottom-line live in the LLM event -->
        <div class="row two-up">
          <RiskGauge v-if="state.risk_score !== null" :score="state.risk_score" />
          <div v-else class="skel surface-1 skel-block" style="min-height: 240px">
            <div class="ring"><span /><span /><span /></div>
            <span class="skel-label">scoring pillars…</span>
          </div>

          <BottomLine v-if="state.bottom_line && state.rating" :rating="state.rating" :bottom-line="state.bottom_line" />
          <div v-else class="skel surface-1 skel-block" style="min-height: 240px">
            <div class="ring"><span /><span /><span /></div>
            <span class="skel-label">writing bottom line…</span>
          </div>
        </div>

        <KpiStrip v-if="state.kpis" :kpis="state.kpis" />
        <div v-else class="skel surface-1 kpi-skel">
          <div v-for="i in 4" :key="i" class="skel-bar" style="height: 2.2rem" />
        </div>

        <PriceChart12mo v-if="state.bars" :bars="state.bars" :markers="state.markers" />
        <div v-else class="skel surface-1" style="min-height: 360px">
          <div class="ring"><span /><span /><span /></div>
          <span class="skel-label">fetching 12-month price from moomoo…</span>
        </div>

        <ScoreBreakdown
          v-if="state.valuation && state.health && state.growth && state.risk_score !== null"
          :valuation="state.valuation.score"
          :health="state.health.score"
          :growth="state.growth.score"
          :total="state.risk_score"
        />

        <div v-if="state.valuation && state.health && state.growth" class="row three-up">
          <PillarGrid title="valuation" :pillar="state.valuation" />
          <PillarGrid title="health" :pillar="state.health" />
          <PillarGrid title="growth" :pillar="state.growth" />
        </div>
        <div v-else class="skel surface-1" style="min-height: 200px">
          <div class="ring"><span /><span /><span /></div>
          <span class="skel-label">analyzing valuation, health, growth…</span>
        </div>

        <QuarterlyTrendTable v-if="state.quarterly" :rows="state.quarterly" />
        <div v-else class="skel surface-1" style="min-height: 220px">
          <div class="ring"><span /><span /><span /></div>
          <span class="skel-label">pulling quarterly results…</span>
        </div>

        <section v-if="state.earnings_update" class="earnings surface-1">
          <header>
            <span class="eyebrow">latest earnings update</span>
            <span class="date" data-mono>{{ state.earnings_update.date }}</span>
          </header>
          <h2>{{ state.earnings_update.headline }}</h2>
          <p v-if="state.earnings_update.body">{{ state.earnings_update.body }}</p>
        </section>

        <CatalystsRisks
          v-if="state.catalysts && state.risks"
          :catalysts="state.catalysts"
          :risks="state.risks"
        />
      </div>
    </main>
  </div>
</template>

<style scoped>
.report {
  max-width: 1280px;
  margin: 0 auto;
  padding: 1.75rem 1.75rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.row { display: grid; gap: 1rem; }
.two-up { grid-template-columns: 1fr; }
.three-up { grid-template-columns: 1fr; }
@media (min-width: 900px) {
  .two-up { grid-template-columns: 320px 1fr; align-items: stretch; }
}
@media (min-width: 1024px) {
  .three-up { grid-template-columns: repeat(3, 1fr); }
}

.loading, .errorbox {
  max-width: 520px;
  margin: 6rem auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--paper-2);
  letter-spacing: 0.04em;
}
.errorbox .mark {
  font-family: var(--font-mono);
  font-size: 1.6rem;
  color: var(--tape-down);
}
.retry {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-1);
  background: transparent;
  border: 1px solid var(--ink-line-strong);
  padding: 0.55rem 1.1rem;
  border-radius: 4px;
  cursor: pointer;
}
.retry:hover { color: var(--accent); border-color: var(--accent); }

.ring { display: inline-flex; gap: 5px; }
.ring span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.3;
  animation: ring-pulse 1.4s ease-in-out infinite;
}
.ring span:nth-child(2) { animation-delay: 0.18s; }
.ring span:nth-child(3) { animation-delay: 0.36s; }
@keyframes ring-pulse {
  0%, 60%, 100% { opacity: 0.25; transform: scale(0.85); }
  30%           { opacity: 1;    transform: scale(1); }
}

.streaming-tag {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent);
  margin-left: 0.5rem;
}
.dots {
  display: inline-flex;
  margin-left: 1px;
  letter-spacing: 0.04em;
}
.dots span {
  opacity: 0.25;
  animation: dot-pulse 1.4s ease-in-out infinite;
}
.dots span:nth-child(2) { animation-delay: 0.2s; }
.dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dot-pulse {
  0%, 60%, 100% { opacity: 0.25; }
  30% { opacity: 1; }
}

.earnings {
  border-radius: 6px;
  padding: 1.1rem 1.3rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.earnings header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.earnings .eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.earnings .date {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-2);
  letter-spacing: 0.04em;
}
.earnings h2 {
  font-family: var(--font-sans);
  font-size: 1rem;
  color: var(--paper-0);
  font-weight: 500;
}
.earnings p {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-2);
  letter-spacing: 0.04em;
}

/* Skeletons — visible while a piece of state is still null. The shimmering
   bar uses a translateX gradient so the user sees the page is alive. */
.skel {
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.85rem;
  padding: 1rem 1.2rem;
  position: relative;
  overflow: hidden;
}
.skel-block { flex-direction: column; }
.skel-label {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.header-skel {
  height: 88px;
  flex-direction: row;
}
.kpi-skel {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1rem;
  padding: 1.1rem 1.2rem;
}
.skel-bar {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--paper-3) 14%, transparent) 0%,
    color-mix(in srgb, var(--paper-3) 24%, transparent) 50%,
    color-mix(in srgb, var(--paper-3) 14%, transparent) 100%
  );
  background-size: 200% 100%;
  border-radius: 4px;
  animation: skel-shimmer 1.4s linear infinite;
}
@keyframes skel-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
