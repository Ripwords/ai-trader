<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { ChartMarker, PriceBar } from '../../../types/research'

const props = defineProps<{ bars: PriceBar[], markers: ChartMarker[] }>()

const UP = '#7ec99c'
const DOWN = '#e07a5f'
const ACCENT = '#d4a96a'

let chart: IChartApi | undefined
let candle: ISeriesApi<'Candlestick'> | undefined
let vol: ISeriesApi<'Histogram'> | undefined
let markersPlugin: ISeriesMarkersPluginApi<Time> | undefined

const el = ref<HTMLDivElement | null>(null)

function toUnix(t: string): UTCTimestamp {
  return Math.floor(new Date(t).getTime() / 1000) as UTCTimestamp
}

function markerColor(kind: ChartMarker['kind']): string {
  switch (kind) {
    case 'earnings':
      return ACCENT
    case 'split':
      return '#9aa0a6'
    case 'guidance':
      return UP
    case 'news':
    default:
      return DOWN
  }
}

function markerShape(kind: ChartMarker['kind']): SeriesMarker<Time>['shape'] {
  switch (kind) {
    case 'earnings':
      return 'circle'
    case 'split':
      return 'square'
    case 'guidance':
      return 'arrowUp'
    case 'news':
    default:
      return 'arrowDown'
  }
}

function snapMarkerTime(time: string): UTCTimestamp | null {
  const target = new Date(time).getTime()
  if (Number.isNaN(target)) return null
  // Find the bar whose timestamp is the closest match. Markers must align to
  // an existing bar or lightweight-charts drops them silently.
  let best: { diff: number, time: UTCTimestamp } | null = null
  for (const b of props.bars) {
    const t = new Date(b.time).getTime()
    const diff = Math.abs(t - target)
    if (!best || diff < best.diff) best = { diff, time: toUnix(b.time) }
  }
  return best?.time ?? null
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

  // Markers: position above the bar so they don't collide with candles.
  const marks: SeriesMarker<Time>[] = []
  for (const m of props.markers) {
    const t = snapMarkerTime(m.time)
    if (t === null) continue
    marks.push({
      time: t,
      position: 'aboveBar',
      shape: markerShape(m.kind),
      color: markerColor(m.kind),
      text: m.label,
      size: 1,
    })
  }
  if (markersPlugin) {
    markersPlugin.setMarkers(marks)
  } else if (candle) {
    markersPlugin = createSeriesMarkers(candle, marks)
  }
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
      vertLine: { color: ACCENT, width: 1, style: 2, labelBackgroundColor: ACCENT },
      horzLine: { color: ACCENT, width: 1, style: 2, labelBackgroundColor: ACCENT },
    },
    height: 360,
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
  markersPlugin = undefined
})

watch(() => [props.bars, props.markers], render, { deep: true })
</script>

<template>
  <section class="chart surface-1">
    <header>
      <div class="eyebrow">12-month price · daily</div>
      <div class="legend">
        <span class="legend-item"><span class="dot" style="background: var(--accent)" />earnings</span>
        <span class="legend-item"><span class="dot" style="background: #7ec99c" />guidance</span>
        <span class="legend-item"><span class="dot" style="background: #e07a5f" />news</span>
      </div>
    </header>
    <div v-if="bars.length === 0" class="empty">chart unavailable · check moomoo OpenD</div>
    <div v-else ref="el" class="surface" />
  </section>
</template>

<style scoped>
.chart {
  border-radius: 6px;
  overflow: hidden;
}
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 1rem 1.2rem;
  border-bottom: 1px solid var(--ink-line);
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.legend {
  display: inline-flex;
  gap: 1rem;
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  color: var(--paper-3);
  text-transform: uppercase;
}
.legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: inline-block;
}
.surface {
  width: 100%;
  height: 360px;
  background: var(--ink-0);
}
.empty {
  padding: 4rem 1.2rem;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-3);
  letter-spacing: 0.04em;
}
</style>
