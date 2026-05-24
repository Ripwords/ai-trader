<script setup lang="ts">
import { computed } from 'vue'
import type { PortfolioMptAnalysisOutput } from '../../../server/lib/portfolio-mpt-analysis'
import type { PortfolioMptPoint } from '../../../server/lib/portfolio-correlation-core'

const props = defineProps<{
  analysis: PortfolioMptAnalysisOutput
}>()

const heatmap = computed(() => props.analysis.heatmap ?? null)
const frontier = computed(() => props.analysis.frontier ?? null)
const frontierPoints = computed(() => frontier.value?.points ?? [])
const samplePoints = computed(() => frontier.value?.sample_points ?? [])
const currentPoint = computed(() => props.analysis.summary.current)
const maxSharpePoint = computed(() => props.analysis.summary.max_sharpe)
const minVariancePoint = computed(() => props.analysis.summary.min_variance)
const missingRequested = computed(() => props.analysis.missing_requested_symbols ?? [])
const excluded = computed(() => props.analysis.excluded ?? [])
const heatmapStyle = computed(() => ({
  gridTemplateColumns: `82px repeat(${Math.max(heatmap.value?.assets.length ?? 0, 1)}, minmax(54px, 1fr))`,
}))
const chartBounds = computed(() => {
  const points = [
    ...frontierPoints.value,
    ...samplePoints.value,
    currentPoint.value,
    maxSharpePoint.value,
    minVariancePoint.value,
  ].filter(point => point && Number.isFinite(point.volatility_annual) && Number.isFinite(point.expected_return_annual))

  const xs = points.map(point => point!.volatility_annual)
  const ys = points.map(point => point!.expected_return_annual)
  const minX = Math.min(0, ...xs)
  const maxX = Math.max(0.01, ...xs)
  const minY = Math.min(0, ...ys)
  const maxY = Math.max(0.01, ...ys)
  const padX = Math.max((maxX - minX) * 0.08, 0.01)
  const padY = Math.max((maxY - minY) * 0.12, 0.01)
  return { minX, maxX: maxX + padX, minY: minY - padY, maxY: maxY + padY }
})
const frontierPolyline = computed(() => frontierPoints.value.map(point => svgPoint(point)).join(' '))

function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${(value * 100).toFixed(digits)}%`
}

function formatRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return value.toFixed(2)
}

function formatCorrelation(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return value.toFixed(2)
}

function topWeights(point: PortfolioMptPoint | null | undefined): string {
  if (!point?.weights) return '--'
  return Object.entries(point.weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([symbol, weight]) => `${symbol} ${(weight * 100).toFixed(0)}%`)
    .join(' / ')
}

function svgPoint(point: { volatility_annual: number, expected_return_annual: number }): string {
  const bounds = chartBounds.value
  const width = 460
  const height = 210
  const left = 42
  const top = 20
  const xRange = bounds.maxX - bounds.minX || 1
  const yRange = bounds.maxY - bounds.minY || 1
  const x = left + ((point.volatility_annual - bounds.minX) / xRange) * width
  const y = top + (1 - ((point.expected_return_annual - bounds.minY) / yRange)) * height
  return `${x.toFixed(1)},${y.toFixed(1)}`
}

function pointX(point: { volatility_annual: number, expected_return_annual: number }): number {
  return Number(svgPoint(point).split(',')[0])
}

function pointY(point: { volatility_annual: number, expected_return_annual: number }): number {
  return Number(svgPoint(point).split(',')[1])
}

function cellStyle(value: number | null) {
  if (value == null || !Number.isFinite(value)) {
    return {
      background: 'rgba(255, 245, 230, 0.035)',
      color: 'var(--paper-3)',
    }
  }
  const strength = Math.min(1, Math.abs(value))
  const alpha = 0.12 + strength * 0.6
  const rgb = value >= 0 ? '126, 201, 156' : '224, 122, 95'
  return {
    background: `rgba(${rgb}, ${alpha})`,
    color: strength > 0.72 ? 'var(--ink-0)' : 'var(--paper-0)',
  }
}
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="mpt-head">
      <div>
        <div class="mpt-eyebrow">portfolio mpt analysis</div>
        <div class="mpt-sub">
          {{ analysis.lookback_days }} sessions · {{ analysis.valid_tickers }} valid tickers · {{ analysis.view }}
        </div>
      </div>
      <div class="mpt-status">
        <span>{{ analysis.summary.sharpe_status }}</span>
        <strong>{{ formatRatio(analysis.summary.sharpe_gap) }}</strong>
      </div>
    </header>

    <div class="mpt-body">
      <div class="mpt-stats">
        <div class="mpt-stat">
          <span>current</span>
          <strong>{{ formatRatio(currentPoint?.sharpe_ratio) }}</strong>
          <small>{{ formatPct(currentPoint?.expected_return_annual) }} exp / {{ formatPct(currentPoint?.volatility_annual) }} risk</small>
          <em>{{ topWeights(currentPoint) }}</em>
        </div>
        <div class="mpt-stat">
          <span>max sharpe sample</span>
          <strong>{{ formatRatio(maxSharpePoint?.sharpe_ratio) }}</strong>
          <small>{{ formatPct(maxSharpePoint?.expected_return_annual) }} exp / {{ formatPct(maxSharpePoint?.volatility_annual) }} risk</small>
          <em>{{ topWeights(maxSharpePoint) }}</em>
        </div>
        <div class="mpt-stat">
          <span>minimum risk sample</span>
          <strong>{{ formatRatio(minVariancePoint?.sharpe_ratio) }}</strong>
          <small>{{ formatPct(minVariancePoint?.expected_return_annual) }} exp / {{ formatPct(minVariancePoint?.volatility_annual) }} risk</small>
          <em>{{ topWeights(minVariancePoint) }}</em>
        </div>
      </div>

      <svg
        v-if="frontier"
        viewBox="0 0 540 270"
        class="mpt-chart"
        role="img"
        aria-label="Portfolio efficient frontier"
      >
        <line x1="42" y1="230" x2="502" y2="230" class="axis" />
        <line x1="42" y1="20" x2="42" y2="230" class="axis" />
        <text x="272" y="262" class="tick">risk</text>
        <text x="12" y="130" class="tick tick-y" transform="rotate(-90 12 130)">expected return</text>
        <circle
          v-for="(point, i) in samplePoints"
          :key="`sample-${i}`"
          :cx="pointX(point)"
          :cy="pointY(point)"
          r="2"
          class="sample"
        />
        <polyline v-if="frontierPolyline" :points="frontierPolyline" class="frontier" />
        <circle v-if="currentPoint" :cx="pointX(currentPoint)" :cy="pointY(currentPoint)" r="6" class="marker current" />
        <circle v-if="maxSharpePoint" :cx="pointX(maxSharpePoint)" :cy="pointY(maxSharpePoint)" r="6" class="marker sharpe" />
        <circle v-if="minVariancePoint" :cx="pointX(minVariancePoint)" :cy="pointY(minVariancePoint)" r="5" class="marker min" />
      </svg>

      <div v-if="heatmap" class="heatmap-block">
        <div class="heatmap-title">
          <span>correlation heatmap</span>
          <strong>{{ heatmap.subset_reason }}</strong>
        </div>
        <div class="heatmap-scroll">
          <div class="heatmap-grid" :style="heatmapStyle" role="table" aria-label="Portfolio correlation heatmap subset">
            <div class="hm-corner" role="columnheader" />
            <div
              v-for="asset in heatmap.assets"
              :key="`col-${asset.symbol}`"
              class="hm-label hm-col"
              role="columnheader"
              :title="asset.name"
            >
              {{ asset.symbol }}
            </div>
            <template v-for="(rowAsset, rowIndex) in heatmap.assets" :key="`row-${rowAsset.symbol}`">
              <div class="hm-label hm-row" role="rowheader" :title="rowAsset.name">
                {{ rowAsset.symbol }}
              </div>
              <div
                v-for="(colAsset, colIndex) in heatmap.assets"
                :key="`${rowAsset.symbol}-${colAsset.symbol}`"
                class="hm-cell"
                role="cell"
                :style="cellStyle(heatmap.matrix[rowIndex]?.[colIndex] ?? null)"
                :title="`${rowAsset.symbol} / ${colAsset.symbol}: ${formatCorrelation(heatmap.matrix[rowIndex]?.[colIndex])}`"
              >
                {{ formatCorrelation(heatmap.matrix[rowIndex]?.[colIndex]) }}
              </div>
            </template>
          </div>
        </div>
      </div>

      <p v-if="missingRequested.length" class="mpt-note">
        missing requested symbols: {{ missingRequested.join(', ') }}
      </p>
      <p v-if="excluded.length" class="mpt-note">
        excluded invalid tickers: {{ excluded.map(row => row.symbol).join(', ') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.mpt-head {
  padding: 1rem 1.1rem;
  border-bottom: 1px solid rgba(255, 245, 230, 0.08);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.mpt-eyebrow,
.mpt-sub,
.mpt-status,
.mpt-stat,
.heatmap-title,
.mpt-note,
.tick {
  font-family: var(--font-mono);
}

.mpt-eyebrow {
  color: var(--paper-2);
  font-size: 0.68rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.mpt-sub {
  margin-top: 0.35rem;
  color: var(--paper-3);
  font-size: 0.68rem;
}

.mpt-status {
  text-align: right;
  color: var(--paper-3);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.mpt-status strong {
  display: block;
  margin-top: 0.35rem;
  color: var(--paper-0);
  font-size: 1rem;
  letter-spacing: 0;
}

.mpt-body {
  padding: 1rem;
  display: grid;
  gap: 1rem;
}

.mpt-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.mpt-stat {
  border: 1px solid rgba(255, 245, 230, 0.08);
  background: rgba(255, 245, 230, 0.025);
  padding: 0.8rem;
  min-width: 0;
}

.mpt-stat span,
.heatmap-title span {
  display: block;
  color: var(--paper-3);
  font-size: 0.62rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.mpt-stat strong {
  display: block;
  margin-top: 0.45rem;
  color: var(--paper-0);
  font-size: 1.35rem;
  font-weight: 500;
}

.mpt-stat small {
  display: block;
  margin-top: 0.25rem;
  color: var(--paper-2);
  font-size: 0.68rem;
}

.mpt-stat em {
  display: block;
  margin-top: 0.55rem;
  color: var(--paper-3);
  font-size: 0.64rem;
  font-style: normal;
  overflow-wrap: anywhere;
}

.mpt-chart {
  width: 100%;
  min-height: 250px;
  background:
    linear-gradient(rgba(255, 245, 230, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 245, 230, 0.035) 1px, transparent 1px),
    var(--ink-0);
  background-size: 42px 42px;
  border: 1px solid rgba(255, 245, 230, 0.08);
}

.axis {
  stroke: rgba(255, 245, 230, 0.22);
}

.tick {
  fill: var(--paper-3);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-anchor: middle;
}

.sample {
  fill: rgba(210, 205, 193, 0.32);
}

.frontier {
  fill: none;
  stroke: var(--accent);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.marker {
  stroke: var(--ink-0);
  stroke-width: 2;
}

.current {
  fill: var(--paper-0);
}

.sharpe {
  fill: var(--accent);
}

.min {
  fill: var(--tape-up);
}

.heatmap-block {
  display: grid;
  gap: 0.6rem;
}

.heatmap-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}

.heatmap-title strong {
  color: var(--paper-2);
  font-size: 0.68rem;
  font-weight: 500;
}

.heatmap-scroll {
  overflow: auto;
  max-height: 360px;
  border: 1px solid rgba(255, 245, 230, 0.08);
  background: rgba(255, 245, 230, 0.08);
}

.heatmap-grid {
  display: grid;
  gap: 1px;
  min-width: max-content;
}

.hm-corner,
.hm-label,
.hm-cell {
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hm-corner,
.hm-label {
  background: var(--ink-2);
  position: sticky;
}

.hm-corner {
  top: 0;
  left: 0;
  z-index: 4;
}

.hm-col {
  top: 0;
  z-index: 3;
}

.hm-row {
  left: 0;
  z-index: 2;
  justify-content: flex-start;
}

.hm-label {
  padding: 0 0.45rem;
  color: var(--paper-2);
  font-family: var(--font-mono);
  font-size: 0.62rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hm-cell {
  min-width: 54px;
  padding: 0 0.3rem;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-variant-numeric: tabular-nums;
}

.mpt-note {
  margin: 0;
  color: var(--paper-3);
  font-size: 0.68rem;
  line-height: 1.5;
}

@media (max-width: 720px) {
  .mpt-head,
  .heatmap-title {
    align-items: flex-start;
    flex-direction: column;
  }

  .mpt-status {
    text-align: left;
  }

  .mpt-stats {
    grid-template-columns: 1fr;
  }
}
</style>
