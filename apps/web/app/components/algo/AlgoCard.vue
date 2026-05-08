<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import {
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'

interface EquityPoint { t: string, v: number }
interface Trade { ts: string, side: 'BUY' | 'SELL', qty: number, price: number, pnl: number }
interface Metrics { pnl: number, win_rate: number, max_dd: number, sharpe: number, n_trades: number }

const props = defineProps<{
  equity: EquityPoint[]
  trades: Trade[]
  metrics: Metrics | null
  status?: string
  error?: string | null
}>()

const el = ref<HTMLDivElement | null>(null)
let chart: IChartApi | undefined
let line: ISeriesApi<'Line'> | undefined

const ACCENT = '#d4a96a'
const UP = '#7ec99c'
const DOWN = '#e07a5f'

function toUnix(t: string): UTCTimestamp {
  return Math.floor(new Date(t).getTime() / 1000) as UTCTimestamp
}

function render() {
  if (!chart || !line) return
  line.setData(props.equity.map(p => ({ time: toUnix(p.t), value: p.v })))
  chart.timeScale().fitContent()
}

onMounted(() => {
  if (!el.value) return
  chart = createChart(el.value, {
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
      vertLine: { color: ACCENT, width: 1, style: 2, labelBackgroundColor: ACCENT },
      horzLine: { color: ACCENT, width: 1, style: 2, labelBackgroundColor: ACCENT },
    },
    height: 280,
    autoSize: true,
  })
  line = chart.addSeries(LineSeries, {
    color: ACCENT,
    lineWidth: 2,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  })
  render()
})

onUnmounted(() => { chart?.remove() })

watch(() => props.equity, render, { deep: false })

function fmt(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
function pct(n: number): string { return `${(n * 100).toFixed(2)}%` }
function shortTs(t: string): string {
  const d = new Date(t)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}
</script>

<template>
  <div class="surface-1 p-5 space-y-5">
    <div v-if="error" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
      {{ error }}
    </div>

    <!-- Metrics row -->
    <div v-if="metrics" class="grid grid-cols-5 gap-4 font-mono text-xs uppercase tracking-[0.18em]">
      <div>
        <div class="text-[var(--paper-3)]">PnL</div>
        <div
          class="text-base mt-1"
          :class="metrics.pnl >= 0 ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'"
          data-mono
        >{{ metrics.pnl >= 0 ? '+' : '' }}{{ fmt(metrics.pnl) }}</div>
      </div>
      <div>
        <div class="text-[var(--paper-3)]">Win-rate</div>
        <div class="text-base mt-1 text-[var(--paper-0)]" data-mono>{{ pct(metrics.win_rate) }}</div>
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
        <div class="text-[var(--paper-3)]">Trades</div>
        <div class="text-base mt-1 text-[var(--paper-0)]" data-mono>{{ metrics.n_trades }}</div>
      </div>
    </div>

    <!-- Equity curve -->
    <div ref="el" class="w-full" />

    <!-- Trades table -->
    <div v-if="trades.length">
      <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mb-2">
        trades
      </div>
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
