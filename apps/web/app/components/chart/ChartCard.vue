<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'

interface Bar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const props = defineProps<{ code: string; ktype: string; bars: Bar[] }>()

const el = ref<HTMLDivElement | null>(null)
let chart: IChartApi | undefined
let candle: ISeriesApi<'Candlestick'> | undefined
let vol: ISeriesApi<'Histogram'> | undefined

const UP = '#7ec99c'
const DOWN = '#e07a5f'

function toUnix(t: string): UTCTimestamp {
  return Math.floor(new Date(t).getTime() / 1000) as UTCTimestamp
}

function render() {
  if (!chart || !candle || !vol) return
  candle.setData(
    props.bars.map(b => ({ time: toUnix(b.time), open: b.open, high: b.high, low: b.low, close: b.close })),
  )
  vol.setData(
    props.bars.map(b => ({
      time: toUnix(b.time),
      value: b.volume,
      color: b.close >= b.open ? `${UP}44` : `${DOWN}44`,
    })),
  )
  chart.timeScale().fitContent()
}

onMounted(() => {
  if (!el.value) return
  chart = createChart(el.value, {
    layout: {
      background: { color: 'transparent' },
      textColor: '#b6b1a4',
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: 12,
    },
    grid: {
      vertLines: { color: 'rgba(255, 245, 230, 0.04)' },
      horzLines: { color: 'rgba(255, 245, 230, 0.04)' },
    },
    rightPriceScale: { borderColor: 'rgba(255, 245, 230, 0.08)' },
    timeScale: { borderColor: 'rgba(255, 245, 230, 0.08)' },
    crosshair: {
      vertLine: { color: '#d4a96a', width: 1, style: 2, labelBackgroundColor: '#d4a96a' },
      horzLine: { color: '#d4a96a', width: 1, style: 2, labelBackgroundColor: '#d4a96a' },
    },
    height: 420,
    autoSize: true,
  })
  candle = chart.addSeries(CandlestickSeries, {
    upColor: UP,
    downColor: DOWN,
    borderVisible: false,
    wickUpColor: UP,
    wickDownColor: DOWN,
  })
  vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' })
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
  render()
})

onUnmounted(() => {
  chart?.remove()
  chart = undefined
  candle = undefined
  vol = undefined
})

watch(() => props.bars, render)

const last = computed(() => props.bars[props.bars.length - 1])
const prev = computed(() => props.bars[props.bars.length - 2])
const change = computed(() => {
  if (!last.value || !prev.value) return null
  const d = last.value.close - prev.value.close
  const pct = (d / prev.value.close) * 100
  return { d, pct, up: d >= 0 }
})

const ktypeLabel: Record<string, string> = {
  '1m': '1-min', '3m': '3-min', '5m': '5-min', '15m': '15-min', '30m': '30-min',
  '60m': '1-hour', '1d': 'daily', '1w': 'weekly', '1M': 'monthly',
}
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 pt-4 pb-4 border-b hairline flex items-end justify-between">
      <div>
        <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
          {{ props.code }} · {{ ktypeLabel[props.ktype] || props.ktype }}
        </div>
        <div v-if="last" class="flex items-baseline gap-3 mt-2">
          <div class="font-mono text-3xl text-[var(--paper-0)] tracking-tight" data-mono>
            {{ last.close.toFixed(2) }}
          </div>
          <div
            v-if="change"
            class="font-mono text-sm"
            :class="change.up ? 'tape-up' : 'tape-down'"
            data-mono
          >
            {{ change.d >= 0 ? '+' : '' }}{{ change.d.toFixed(2) }}
            ({{ change.pct >= 0 ? '+' : '' }}{{ change.pct.toFixed(2) }}%)
          </div>
        </div>
      </div>
      <div class="text-right">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">bars</div>
        <div class="font-mono text-sm text-[var(--paper-2)]" data-mono>{{ props.bars.length }}</div>
      </div>
    </header>
    <div ref="el" class="w-full h-[420px] bg-[var(--ink-0)]" />
  </div>
</template>
