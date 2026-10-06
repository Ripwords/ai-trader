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

// The chart draws on a canvas, which cannot resolve CSS variables, so the
// design tokens are read once from :root when the chart mounts.
const palette = { up: '', down: '', accent: '', muted: '', text: '', line: '', lineStrong: '' }

function readPalette() {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string) => css.getPropertyValue(name).trim()
  palette.up = token('--tape-up')
  palette.down = token('--tape-down')
  palette.accent = token('--accent')
  palette.muted = token('--paper-3')
  palette.text = token('--paper-2')
  palette.line = token('--ink-line')
  palette.lineStrong = token('--ink-line-strong')
}

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
      return palette.accent
    case 'split':
      return palette.muted
    case 'guidance':
      return palette.up
    case 'news':
    default:
      return palette.down
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
      color: b.close >= b.open ? `${palette.up}44` : `${palette.down}44`,
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
  readPalette()
  chart = createChart(el.value, {
    layout: {
      background: { color: 'transparent' },
      textColor: palette.text,
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: 12,
    },
    grid: {
      vertLines: { color: palette.line },
      horzLines: { color: palette.line },
    },
    rightPriceScale: { borderColor: palette.lineStrong },
    timeScale: { borderColor: palette.lineStrong },
    crosshair: {
      vertLine: { color: palette.accent, width: 1, style: 2, labelBackgroundColor: palette.accent },
      horzLine: { color: palette.accent, width: 1, style: 2, labelBackgroundColor: palette.accent },
    },
    height: 360,
    autoSize: true,
  })
  candle = chart.addSeries(CandlestickSeries, {
    upColor: palette.up,
    downColor: palette.down,
    borderVisible: false,
    wickUpColor: palette.up,
    wickDownColor: palette.down,
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
        <span class="legend-item"><span class="dot" style="background: var(--tape-up)" />guidance</span>
        <span class="legend-item"><span class="dot" style="background: var(--tape-down)" />news</span>
      </div>
    </header>
    <div v-if="bars.length === 0" class="empty">chart unavailable. moomoo returned no price history.</div>
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
  flex-wrap: wrap;
  gap: 0.4rem 1rem;
  padding: 1rem 1.2rem;
  border-bottom: 1px solid var(--ink-line);
}

@media (max-width: 400px) {
  header { padding: 0.85rem 1rem; }
  .legend { flex-wrap: wrap; gap: 0.35rem 0.7rem; }
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.legend {
  display: inline-flex;
  gap: 1rem;
  font-family: var(--font-mono);
  font-size: 11px;
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
