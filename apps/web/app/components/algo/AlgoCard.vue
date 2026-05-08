<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import {
  CandlestickSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'

interface EquityPoint { t: string, v: number }
interface Bar { time: string, open: number, high: number, low: number, close: number }
interface Trade { ts: string, side: 'BUY' | 'SELL', qty: number, price: number, pnl: number }
interface Metrics {
  pnl: number, win_rate: number, max_dd: number, sharpe: number,
  fills: number, round_trips: number, wins: number, losses: number,
  benchmark_pnl: number,
}

const props = defineProps<{
  equity: EquityPoint[]
  benchmark: EquityPoint[]
  priceBars: Bar[]
  trades: Trade[]
  metrics: Metrics | null
  status?: string
  error?: string | null
}>()

const priceEl = ref<HTMLDivElement | null>(null)
const equityEl = ref<HTMLDivElement | null>(null)
let priceChart: IChartApi | undefined
let equityChart: IChartApi | undefined
let candle: ISeriesApi<'Candlestick'> | undefined
let candleMarkers: ISeriesMarkersPluginApi<Time> | undefined
let equityLine: ISeriesApi<'Line'> | undefined
let benchLine: ISeriesApi<'Line'> | undefined

const ACCENT = '#d4a96a'
const BENCH = '#6b6558'
const UP = '#7ec99c'
const DOWN = '#e07a5f'

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
  if (candle) {
    candle.setData(props.priceBars.map(b => ({
      time: toUnix(b.time),
      open: b.open, high: b.high, low: b.low, close: b.close,
    })))
    const markers: SeriesMarker<Time>[] = props.trades.map(t => t.side === 'BUY'
      ? {
          time: toUnix(t.ts) as Time, position: 'belowBar',
          color: UP, shape: 'arrowUp', text: `BUY ${t.qty}`,
        }
      : {
          time: toUnix(t.ts) as Time, position: 'aboveBar',
          color: DOWN, shape: 'arrowDown', text: `SELL ${t.qty}`,
        })
    if (!candleMarkers) {
      candleMarkers = createSeriesMarkers(candle, markers)
    } else {
      candleMarkers.setMarkers(markers)
    }
  }
  if (equityLine) {
    equityLine.setData(props.equity.map(p => ({ time: toUnix(p.t), value: p.v })))
  }
  if (benchLine) {
    benchLine.setData(props.benchmark.map(p => ({ time: toUnix(p.t), value: p.v })))
  }
  priceChart?.timeScale().fitContent()
  equityChart?.timeScale().fitContent()
}

let syncing = false
function syncRanges() {
  if (!priceChart || !equityChart) return
  priceChart.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
    if (syncing || !range) return
    syncing = true
    equityChart!.timeScale().setVisibleLogicalRange(range)
    syncing = false
  })
  equityChart.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
    if (syncing || !range) return
    syncing = true
    priceChart!.timeScale().setVisibleLogicalRange(range)
    syncing = false
  })
}

// Mirror the crosshair from one chart onto the other so hovering on the
// price chart also shows the cursor on the equity chart at the same time
// (and vice versa). lightweight-charts' setCrosshairPosition needs a
// (price, time, series) triple; for the mirror we use the latest known
// value of the target chart's primary series at that timestamp, with a
// fallback to clearing when the cursor leaves the source chart.
let crosshairSyncing = false
function syncCrosshair() {
  if (!priceChart || !equityChart || !candle || !equityLine) return

  // Build quick-lookup maps from time → value for each chart's primary series.
  // Rebuilt on every render() through the watch below.
  function buildLookups() {
    priceByTime.clear()
    for (const b of props.priceBars) priceByTime.set(toUnix(b.time), b.close)
    equityByTime.clear()
    for (const p of props.equity) equityByTime.set(toUnix(p.t), p.v)
  }
  buildLookups()
  // Re-build whenever data changes; cheap.
  watch(() => [props.priceBars, props.equity], buildLookups, { deep: false })

  priceChart.subscribeCrosshairMove((param) => {
    if (crosshairSyncing) return
    crosshairSyncing = true
    if (param.time === undefined) {
      equityChart!.clearCrosshairPosition()
    } else {
      const v = equityByTime.get(param.time as UTCTimestamp)
      if (v !== undefined && equityLine) {
        equityChart!.setCrosshairPosition(v, param.time, equityLine)
      } else {
        equityChart!.clearCrosshairPosition()
      }
    }
    crosshairSyncing = false
  })

  equityChart.subscribeCrosshairMove((param) => {
    if (crosshairSyncing) return
    crosshairSyncing = true
    if (param.time === undefined) {
      priceChart!.clearCrosshairPosition()
    } else {
      const c = priceByTime.get(param.time as UTCTimestamp)
      if (c !== undefined && candle) {
        priceChart!.setCrosshairPosition(c, param.time, candle)
      } else {
        priceChart!.clearCrosshairPosition()
      }
    }
    crosshairSyncing = false
  })
}

const priceByTime = new Map<UTCTimestamp, number>()
const equityByTime = new Map<UTCTimestamp, number>()

onMounted(() => {
  if (priceEl.value) {
    priceChart = createChart(priceEl.value, { ...makeBaseOptions(), height: 240 })
    candle = priceChart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN,
      borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
    })
  }
  if (equityEl.value) {
    equityChart = createChart(equityEl.value, { ...makeBaseOptions(), height: 200 })
    equityLine = equityChart.addSeries(LineSeries, {
      color: ACCENT, lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    benchLine = equityChart.addSeries(LineSeries, {
      color: BENCH, lineWidth: 1, lineStyle: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
  }
  syncRanges()
  syncCrosshair()
  render()
})

onUnmounted(() => {
  priceChart?.remove()
  equityChart?.remove()
})

watch(() => [props.equity, props.benchmark, props.priceBars, props.trades], render, { deep: false })

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
function pct(n: number): string { return `${(n * 100).toFixed(2)}%` }
function shortTs(t: string): string { return new Date(t).toISOString().slice(0, 16).replace('T', ' ') }
</script>

<template>
  <div class="surface-1 p-5 space-y-5">
    <div v-if="error" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
      {{ error }}
    </div>

    <!-- Metrics row -->
    <div v-if="metrics" class="grid grid-cols-7 gap-4 font-mono text-xs uppercase tracking-[0.18em]">
      <div>
        <div class="text-[var(--paper-3)]">PnL</div>
        <div
          class="text-base mt-1"
          :class="metrics.pnl >= 0 ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'"
          data-mono
        >{{ metrics.pnl >= 0 ? '+' : '' }}{{ fmt(metrics.pnl) }}</div>
      </div>
      <div>
        <div class="text-[var(--paper-3)]">Bench</div>
        <div
          class="text-base mt-1"
          :class="metrics.benchmark_pnl >= 0 ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'"
          data-mono
        >{{ metrics.benchmark_pnl >= 0 ? '+' : '' }}{{ fmt(metrics.benchmark_pnl) }}</div>
      </div>
      <div>
        <div class="text-[var(--paper-3)]">Win-rate</div>
        <div class="text-base mt-1 text-[var(--paper-0)]" data-mono>
          {{ metrics.round_trips > 0 ? pct(metrics.win_rate) : '—' }}
        </div>
      </div>
      <div>
        <div class="text-[var(--paper-3)]">Max DD</div>
        <div class="text-base mt-1 text-[var(--tape-down)]" data-mono>{{ pct(metrics.max_dd) }}</div>
      </div>
      <div>
        <div class="text-[var(--paper-3)]">Sharpe</div>
        <div class="text-base mt-1 text-[var(--paper-0)]" data-mono>{{ fmt(metrics.sharpe, 3) }}</div>
      </div>
      <div>
        <div class="text-[var(--paper-3)]">Fills</div>
        <div class="text-base mt-1 text-[var(--paper-0)]" data-mono>{{ metrics.fills }}</div>
      </div>
      <div>
        <div class="text-[var(--paper-3)]">Round-trips</div>
        <div class="text-base mt-1 text-[var(--paper-0)]" data-mono>
          {{ metrics.round_trips }}
          <span v-if="metrics.round_trips > 0" class="text-xs text-[var(--paper-3)] ml-1">
            ({{ metrics.wins }}W / {{ metrics.losses }}L)
          </span>
        </div>
      </div>
    </div>

    <!-- Stacked charts -->
    <div class="space-y-2">
      <div class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)]">price · trade markers</div>
      <div ref="priceEl" class="w-full" />
      <div class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] flex gap-4 items-center">
        <span>equity</span>
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block w-3 h-[2px] bg-[#d4a96a]" /> strategy
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block w-3 border-t border-dashed border-[#6b6558]" /> buy &amp; hold
        </span>
      </div>
      <div ref="equityEl" class="w-full" />
    </div>

    <!-- Trades table -->
    <div v-if="trades.length">
      <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mb-2">trades</div>
      <div class="max-h-72 overflow-y-auto scroll-hidden">
        <table class="w-full font-mono text-xs">
          <thead class="text-[var(--paper-3)] uppercase tracking-wider">
            <tr>
              <th class="text-left py-1">when</th>
              <th class="text-left py-1">side</th>
              <th class="text-right py-1">qty</th>
              <th class="text-right py-1">price</th>
              <th class="text-right py-1">pnl</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(t, i) in trades" :key="i" class="border-t border-[rgba(255,245,230,0.06)]">
              <td class="py-1.5 text-[var(--paper-2)]">{{ shortTs(t.ts) }}</td>
              <td
                class="py-1.5"
                :class="t.side === 'BUY' ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'"
              >{{ t.side }}</td>
              <td class="py-1.5 text-right text-[var(--paper-1)]" data-mono>{{ t.qty }}</td>
              <td class="py-1.5 text-right text-[var(--paper-1)]" data-mono>{{ fmt(t.price) }}</td>
              <td
                class="py-1.5 text-right"
                :class="t.pnl > 0 ? 'text-[var(--tape-up)]' : t.pnl < 0 ? 'text-[var(--tape-down)]' : 'text-[var(--paper-3)]'"
                data-mono
              >{{ t.pnl >= 0 ? '+' : '' }}{{ fmt(t.pnl) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
