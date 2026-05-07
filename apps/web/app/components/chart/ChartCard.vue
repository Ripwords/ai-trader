<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { CandlestickSeries, HistogramSeries, createChart, type IChartApi, type ISeriesApi } from 'lightweight-charts'

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

function toUnix(t: string) {
  return Math.floor(new Date(t).getTime() / 1000)
}

function render() {
  if (!chart || !candle || !vol) return
  candle.setData(
    props.bars.map((b) => ({ time: toUnix(b.time) as any, open: b.open, high: b.high, low: b.low, close: b.close })),
  )
  vol.setData(
    props.bars.map((b) => ({
      time: toUnix(b.time) as any,
      value: b.volume,
      color: b.close >= b.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
    })),
  )
  chart.timeScale().fitContent()
}

onMounted(() => {
  if (!el.value) return
  chart = createChart(el.value, {
    layout: { background: { color: 'transparent' }, textColor: '#888' },
    grid: { vertLines: { color: 'rgba(127,127,127,0.1)' }, horzLines: { color: 'rgba(127,127,127,0.1)' } },
    height: 360,
    autoSize: true,
  })
  candle = chart.addSeries(CandlestickSeries, {
    upColor: '#26a69a',
    downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
  })
  vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '' })
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
  render()
})

watch(() => props.bars, render)
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex justify-between items-center">
        <div class="font-medium">{{ props.code }} · {{ props.ktype }}</div>
        <div class="text-xs text-gray-500" v-if="props.bars.length">
          last {{ props.bars[props.bars.length - 1].close }}
        </div>
      </div>
    </template>
    <div ref="el" class="w-full h-[360px]" />
  </UCard>
</template>
