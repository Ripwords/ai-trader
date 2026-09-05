<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { EquityPoint, PerformanceStats } from '../../../server/lib/portfolio-history'

const props = defineProps<{
  series: EquityPoint[]
  stats: PerformanceStats | null
  pending: boolean
  capturing: boolean
  errorMessage: string
  message: string
}>()

const emit = defineEmits<{ capture: [] }>()

const ACCENT = '#d4a96a'
const CASH = '#6b6558'

const chartEl = ref<HTMLDivElement | null>(null)
let chart: IChartApi | undefined
let netWorthLine: ISeriesApi<'Line'> | undefined
let cashLine: ISeriesApi<'Line'> | undefined

function toUnix(t: string): UTCTimestamp {
  return Math.floor(new Date(t).getTime() / 1000) as UTCTimestamp
}

function makeBaseOptions() {
  return {
    layout: {
      background: { color: 'transparent' },
      textColor: '#b6b1a4',
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255, 245, 230, 0.04)' },
      horzLines: { color: 'rgba(255, 245, 230, 0.04)' },
    },
    rightPriceScale: { borderColor: 'rgba(255, 245, 230, 0.08)' },
    timeScale: { borderColor: 'rgba(255, 245, 230, 0.08)' },
    crosshair: {
      vertLine: { color: ACCENT, width: 1 as const, style: 2 as const, labelBackgroundColor: ACCENT },
      horzLine: { color: ACCENT, width: 1 as const, style: 2 as const, labelBackgroundColor: ACCENT },
    },
    autoSize: true,
  }
}

function render() {
  if (!netWorthLine || !cashLine) return
  // lightweight-charts requires strictly ascending unique times — snapshots
  // taken the same second (auto + manual) would violate that, so dedupe.
  const seen = new Set<number>()
  const points = props.series.filter((p) => {
    const t = toUnix(p.t)
    if (seen.has(t)) return false
    seen.add(t)
    return true
  })
  netWorthLine.setData(points.map(p => ({ time: toUnix(p.t), value: p.netWorth })))
  cashLine.setData(points.map(p => ({ time: toUnix(p.t), value: p.cash })))
  chart?.timeScale().fitContent()
}

function mountChart(el: HTMLElement) {
  chart = createChart(el, { ...makeBaseOptions(), height: 220 })
  netWorthLine = chart.addSeries(LineSeries, {
    color: ACCENT, lineWidth: 2,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  })
  cashLine = chart.addSeries(LineSeries, {
    color: CASH, lineWidth: 1, lineStyle: 2,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  })
}

// The container sits behind v-else="hasHistory", so it can appear after
// mount (first snapshot captured from the empty state). Build the chart
// whenever the element shows up, not only on mount.
watch(chartEl, (el) => {
  if (el && !chart) {
    mountChart(el)
    render()
  }
}, { immediate: true })

onUnmounted(() => {
  chart?.remove()
})

watch(() => props.series, render, { deep: false })

const hasHistory = computed(() => props.series.length > 0)

const fmtPct = (n: number | null | undefined, digits = 2) => {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

const pnlClass = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return 'text-[var(--paper-2)]'
  if (n > 0) return 'tape-up'
  if (n < 0) return 'tape-down'
  return 'text-[var(--paper-2)]'
}

const sinceLabel = computed(() => {
  const first = props.stats?.firstAt
  return first ? `since ${first.slice(0, 10)}` : 'vs first snapshot'
})
</script>

<template>
  <section class="surface-1 p-6">
    <div class="flex items-baseline justify-between gap-4 mb-5">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">performance</div>
      <div class="flex items-baseline gap-4">
        <span v-if="stats && stats.count > 0" class="font-mono text-xs text-[var(--paper-3)]">
          {{ stats.count }} snapshot{{ stats.count === 1 ? '' : 's' }}
        </span>
        <button
          class="tap font-mono text-xs uppercase tracking-[0.16em] text-[var(--paper-3)] hover:text-[var(--accent)] disabled:opacity-40 disabled:hover:text-[var(--paper-3)]"
          :disabled="capturing"
          @click="emit('capture')"
        >
          {{ capturing ? 'capturing…' : 'capture snapshot' }}
        </button>
      </div>
    </div>

    <div v-if="errorMessage" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
      failed to load performance: {{ errorMessage }}
    </div>

    <div v-else-if="pending && !hasHistory" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
      loading performance…
    </div>

    <div v-else-if="!hasHistory" class="py-10 text-center space-y-2">
      <div class="font-mono text-sm text-[var(--paper-2)]">no snapshots yet</div>
      <div class="font-mono text-xs text-[var(--paper-3)]">
        the equity curve builds from daily auto-captures — or take the first one now with "capture snapshot".
      </div>
    </div>

    <div v-else class="space-y-5">
      <div class="grid grid-cols-1 min-[380px]:grid-cols-2 md:grid-cols-5 gap-3">
        <div class="bg-[var(--ink-2)] border hairline p-3">
          <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">total return</div>
          <div class="mt-1 font-mono stat-value" :class="pnlClass(stats?.totalReturnPct)" data-mono>
            {{ fmtPct(stats?.totalReturnPct) }}
          </div>
          <div class="font-mono text-[10px] text-[var(--paper-3)] mt-1">{{ sinceLabel }}</div>
        </div>
        <div class="bg-[var(--ink-2)] border hairline p-3">
          <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">max drawdown</div>
          <div class="mt-1 font-mono stat-value" :class="pnlClass(stats?.maxDrawdownPct)" data-mono>
            {{ fmtPct(stats?.maxDrawdownPct) }}
          </div>
          <div class="font-mono text-[10px] text-[var(--paper-3)] mt-1">peak to trough</div>
        </div>
        <div class="bg-[var(--ink-2)] border hairline p-3">
          <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">1d</div>
          <div class="mt-1 font-mono stat-value" :class="pnlClass(stats?.periodReturns.d1)" data-mono>
            {{ fmtPct(stats?.periodReturns.d1) }}
          </div>
        </div>
        <div class="bg-[var(--ink-2)] border hairline p-3">
          <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">7d</div>
          <div class="mt-1 font-mono stat-value" :class="pnlClass(stats?.periodReturns.d7)" data-mono>
            {{ fmtPct(stats?.periodReturns.d7) }}
          </div>
        </div>
        <div class="bg-[var(--ink-2)] border hairline p-3">
          <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">30d</div>
          <div class="mt-1 font-mono stat-value" :class="pnlClass(stats?.periodReturns.d30)" data-mono>
            {{ fmtPct(stats?.periodReturns.d30) }}
          </div>
        </div>
      </div>

      <div>
        <div ref="chartEl" class="w-full" />
        <div class="mt-2 flex items-center gap-5 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">
          <span class="flex items-center gap-1.5">
            <span class="inline-block w-3 h-[2px]" :style="{ background: ACCENT }" /> net worth
          </span>
          <span class="flex items-center gap-1.5">
            <span class="inline-block w-3 h-[2px]" :style="{ background: CASH }" /> cash
          </span>
          <span v-if="stats?.currency" class="ml-auto">{{ stats.currency }} base</span>
        </div>
      </div>
    </div>

    <div v-if="message" class="mt-3 font-mono text-[10px] text-[var(--paper-3)] truncate">
      {{ message }}
    </div>
  </section>
</template>
