<script setup lang="ts">
import { computed } from 'vue'
import type { PortfolioCorrelationResult } from '../../../server/lib/portfolio-correlation-core'

const props = withDefaults(defineProps<{
  correlation: PortfolioCorrelationResult | null
  pending?: boolean
  errorMessage?: string
}>(), {
  pending: false,
  errorMessage: '',
})

const assets = computed(() => props.correlation?.assets ?? [])
const hasMatrix = computed(() => assets.value.length > 0)
const matrixStyle = computed(() => ({
  gridTemplateColumns: `112px repeat(${Math.max(assets.value.length, 1)}, minmax(72px, 1fr))`,
}))
const simulationPoints = computed(() => props.correlation?.simulations ?? [])
const frontierPoints = computed(() => props.correlation?.efficient_frontier ?? [])
const currentPoint = computed(() => props.correlation?.current_portfolio ?? null)
const minVariancePoint = computed(() => props.correlation?.min_variance_portfolio ?? null)
const maxSharpePoint = computed(() => props.correlation?.max_sharpe_portfolio ?? null)
const riskFreePoint = computed(() => ({
  volatility_annual: 0,
  expected_return_annual: props.correlation?.risk_free_rate ?? 0,
}))
const chartBounds = computed(() => {
  const points = [
    ...simulationPoints.value,
    ...frontierPoints.value,
    currentPoint.value,
    minVariancePoint.value,
    maxSharpePoint.value,
    riskFreePoint.value,
  ].filter(point => point && Number.isFinite(point.volatility_annual) && Number.isFinite(point.expected_return_annual))

  const xs = points.map(point => point!.volatility_annual)
  const ys = points.map(point => point!.expected_return_annual)
  const minX = Math.min(0, ...xs)
  const maxX = Math.max(0.01, ...xs)
  const minY = Math.min(0, ...ys)
  const maxY = Math.max(0.01, ...ys)
  const padX = Math.max((maxX - minX) * 0.08, 0.01)
  const padY = Math.max((maxY - minY) * 0.12, 0.01)
  return {
    minX,
    maxX: maxX + padX,
    minY: minY - padY,
    maxY: maxY + padY,
  }
})
const hasFrontier = computed(() => simulationPoints.value.length > 0 && currentPoint.value)
const frontierPolyline = computed(() => frontierPoints.value.map(point => svgPoint(point)).join(' '))
const capitalAllocationLine = computed(() => {
  if (!maxSharpePoint.value) return ''
  return `${svgPoint(riskFreePoint.value)} ${svgPoint(maxSharpePoint.value)}`
})
const sharpeGap = computed(() => {
  const current = currentPoint.value?.sharpe_ratio
  const best = maxSharpePoint.value?.sharpe_ratio
  if (current == null || best == null || !Number.isFinite(current) || !Number.isFinite(best)) return null
  return best - current
})
const sharpeCheck = computed(() => {
  const gap = sharpeGap.value
  if (gap == null) return 'insufficient ratio data'
  if (gap <= 0.05) return 'near sampled max'
  if (gap <= 0.25) return 'moderate gap'
  return 'large gap'
})
const footnote = computed(() => {
  const excluded = props.correlation?.excluded ?? []
  if (excluded.length === 0) return ''
  const symbols = excluded.map(row => row.symbol).join(', ')
  return `Footnote: tickers Yahoo can't find or price with enough history are excluded: ${symbols}.`
})

function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return `${(value * 100).toFixed(digits)}%`
}

function formatRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--'
  return value.toFixed(2)
}

function topWeights(weights: Record<string, number> | undefined): string {
  if (!weights) return '--'
  return Object.entries(weights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([symbol, weight]) => `${symbol} ${(weight * 100).toFixed(0)}%`)
    .join(' / ')
}

function svgPoint(point: { volatility_annual: number, expected_return_annual: number }): string {
  const bounds = chartBounds.value
  const width = 780
  const height = 390
  const left = 82
  const top = 38
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

function correlationAt(row: number, col: number): number | null {
  return props.correlation?.matrix[row]?.[col] ?? null
}

function formatCorrelation(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(2)
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
  <section class="surface-1 p-6">
    <div class="flex flex-col md:flex-row md:items-baseline md:justify-between gap-2 mb-5">
      <div>
        <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">modern portfolio theory</div>
        <div class="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">
          expected return w^T mu / risk w^T Sigma w
        </div>
      </div>
      <div class="font-mono text-xs text-[var(--paper-3)]">
        <span v-if="correlation">{{ correlation.lookback_days }} daily sessions · {{ assets.length }} valid tickers</span>
        <span v-else>daily returns</span>
      </div>
    </div>

    <div v-if="errorMessage" class="font-mono text-sm text-[var(--tape-down)]">
      failed to load correlation matrix: {{ errorMessage }}
    </div>
    <div v-else-if="pending && !correlation" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
      loading correlations…
    </div>
    <div v-else-if="!correlation" class="font-mono text-xs text-[var(--paper-3)]">
      no correlation data available
    </div>
    <div v-else class="space-y-7">
      <div v-if="hasFrontier" class="frontier-layout">
        <div class="frontier-shell">
          <svg viewBox="0 0 920 500" class="frontier-chart" role="img" aria-label="Expected return versus portfolio risk efficient frontier">
            <line x1="82" y1="428" x2="862" y2="428" class="axis" />
            <line x1="82" y1="38" x2="82" y2="428" class="axis" />
            <text x="472" y="484" class="axis-title">portfolio risk: sigma = sqrt(w^T Sigma w)</text>
            <text x="22" y="233" class="axis-title axis-title-y" transform="rotate(-90 22 233)">portfolio expected return: w^T mu</text>
            <text x="82" y="456" class="tick">{{ formatPct(chartBounds.minX) }}</text>
            <text x="862" y="456" text-anchor="end" class="tick">{{ formatPct(chartBounds.maxX) }}</text>
            <text x="70" y="432" text-anchor="end" class="tick">{{ formatPct(chartBounds.minY) }}</text>
            <text x="70" y="44" text-anchor="end" class="tick">{{ formatPct(chartBounds.maxY) }}</text>

            <circle
              v-for="(point, i) in simulationPoints"
              :key="`sim-${i}`"
              :cx="pointX(point)"
              :cy="pointY(point)"
              r="2.2"
              class="sample-point"
            />
            <polyline v-if="capitalAllocationLine" :points="capitalAllocationLine" class="cal-line" />
            <polyline v-if="frontierPolyline" :points="frontierPolyline" class="frontier-line" />
            <g>
              <circle :cx="pointX(riskFreePoint)" :cy="pointY(riskFreePoint)" r="5" class="marker marker-rf" />
              <text :x="pointX(riskFreePoint) + 9" :y="pointY(riskFreePoint) - 8" class="marker-label">risk-free</text>
            </g>

            <g v-if="minVariancePoint">
              <circle :cx="pointX(minVariancePoint)" :cy="pointY(minVariancePoint)" r="7" class="marker marker-min" />
              <text :x="pointX(minVariancePoint) + 10" :y="pointY(minVariancePoint) - 8" class="marker-label">min risk</text>
            </g>
            <g v-if="maxSharpePoint">
              <circle :cx="pointX(maxSharpePoint)" :cy="pointY(maxSharpePoint)" r="7" class="marker marker-sharpe" />
              <text :x="pointX(maxSharpePoint) + 10" :y="pointY(maxSharpePoint) + 16" class="marker-label">max sharpe sample</text>
            </g>
            <g v-if="currentPoint">
              <circle :cx="pointX(currentPoint)" :cy="pointY(currentPoint)" r="8" class="marker marker-current" />
              <text :x="pointX(currentPoint) + 11" :y="pointY(currentPoint) - 11" class="marker-label marker-label-current">current</text>
            </g>
          </svg>
        </div>

        <div class="mpt-stat-strip">
          <div class="mpt-stat">
            <div class="mpt-stat__label">sharpe check</div>
            <div class="mpt-stat__grid">
              <span>status</span><strong>{{ sharpeCheck }}</strong>
              <span>gap to sample</span><strong>{{ sharpeGap == null ? '--' : sharpeGap.toFixed(2) }}</strong>
              <span>risk-free</span><strong>{{ formatPct(correlation.risk_free_rate) }}</strong>
            </div>
            <div class="mpt-stat__weights">capital allocation line uses the sampled max-Sharpe slope.</div>
          </div>
          <div class="mpt-stat">
            <div class="mpt-stat__label">current portfolio</div>
            <div class="mpt-stat__grid">
              <span>expected</span><strong>{{ formatPct(currentPoint?.expected_return_annual) }}</strong>
              <span>risk</span><strong>{{ formatPct(currentPoint?.volatility_annual) }}</strong>
              <span>sharpe</span><strong>{{ formatRatio(currentPoint?.sharpe_ratio) }}</strong>
            </div>
            <div class="mpt-stat__weights">{{ topWeights(currentPoint?.weights) }}</div>
          </div>
          <div class="mpt-stat">
            <div class="mpt-stat__label">minimum-risk sample</div>
            <div class="mpt-stat__grid">
              <span>expected</span><strong>{{ formatPct(minVariancePoint?.expected_return_annual) }}</strong>
              <span>risk</span><strong>{{ formatPct(minVariancePoint?.volatility_annual) }}</strong>
              <span>sharpe</span><strong>{{ formatRatio(minVariancePoint?.sharpe_ratio) }}</strong>
            </div>
            <div class="mpt-stat__weights">{{ topWeights(minVariancePoint?.weights) }}</div>
          </div>
          <div class="mpt-stat">
            <div class="mpt-stat__label">max-sharpe sample</div>
            <div class="mpt-stat__grid">
              <span>expected</span><strong>{{ formatPct(maxSharpePoint?.expected_return_annual) }}</strong>
              <span>risk</span><strong>{{ formatPct(maxSharpePoint?.volatility_annual) }}</strong>
              <span>sharpe</span><strong>{{ formatRatio(maxSharpePoint?.sharpe_ratio) }}</strong>
            </div>
            <div class="mpt-stat__weights">{{ topWeights(maxSharpePoint?.weights) }}</div>
          </div>
        </div>
      </div>
      <div v-else class="font-mono text-xs text-[var(--paper-3)]">
        efficient frontier needs at least one valid ticker with enough daily returns
      </div>

      <div>
        <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--paper-3)] mb-3">correlation matrix</div>
      <div v-if="hasMatrix" class="matrix-scroll pb-1">
        <div class="correlation-grid min-w-max" :style="matrixStyle" role="table" aria-label="Portfolio correlation matrix">
          <div class="corner sticky-corner" role="columnheader" />
          <div
            v-for="asset in assets"
            :key="`col-${asset.symbol}`"
            class="axis-label column-label sticky-column-label"
            role="columnheader"
            :title="asset.name"
          >
            {{ asset.symbol }}
          </div>

          <template v-for="(rowAsset, rowIndex) in assets" :key="`row-${rowAsset.symbol}`">
            <div class="axis-label row-label sticky-row-label" role="rowheader" :title="rowAsset.name">
              {{ rowAsset.symbol }}
            </div>
            <div
              v-for="(colAsset, colIndex) in assets"
              :key="`${rowAsset.symbol}-${colAsset.symbol}`"
              class="correlation-cell"
              role="cell"
              :style="cellStyle(correlationAt(rowIndex, colIndex))"
              :title="`${rowAsset.symbol} / ${colAsset.symbol}: ${formatCorrelation(correlationAt(rowIndex, colIndex))}`"
            >
              {{ formatCorrelation(correlationAt(rowIndex, colIndex)) }}
            </div>
          </template>
        </div>
      </div>
      <div v-else class="font-mono text-xs text-[var(--paper-3)]">
        no valid tickers with enough price history
      </div>
      </div>

      <p v-if="footnote" class="font-mono text-[10px] leading-relaxed text-[var(--paper-3)]">
        {{ footnote }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.frontier-shell {
  background:
    linear-gradient(rgba(255, 245, 230, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 245, 230, 0.035) 1px, transparent 1px),
    var(--ink-0);
  background-size: 56px 56px;
  border: 1px solid rgba(255, 245, 230, 0.08);
  overflow: hidden;
}

.frontier-layout {
  display: grid;
  gap: 1rem;
}

.frontier-chart {
  display: block;
  width: 100%;
  min-height: 420px;
  max-height: min(64vh, 540px);
  aspect-ratio: 920 / 500;
}

.axis {
  stroke: rgba(255, 245, 230, 0.25);
  stroke-width: 1;
}

.axis-title,
.tick,
.marker-label {
  fill: var(--paper-3);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.axis-title {
  font-size: 12px;
  text-anchor: middle;
}

.axis-title-y {
  text-anchor: middle;
}

.sample-point {
  fill: rgba(210, 205, 193, 0.34);
}

.frontier-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.cal-line {
  fill: none;
  stroke: rgba(255, 245, 230, 0.38);
  stroke-width: 1.5;
  stroke-dasharray: 6 6;
}

.marker {
  stroke: var(--ink-0);
  stroke-width: 2;
}

.marker-current {
  fill: var(--paper-0);
}

.marker-min {
  fill: var(--tape-up);
}

.marker-sharpe {
  fill: var(--accent);
}

.marker-rf {
  fill: var(--paper-3);
}

.marker-label-current {
  fill: var(--paper-0);
}

.mpt-stat {
  border: 1px solid rgba(255, 245, 230, 0.08);
  background: var(--ink-2);
  padding: 0.9rem;
}

.mpt-stat-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.85rem;
}

.mpt-stat__label {
  color: var(--paper-3);
  font-family: var(--font-mono);
  font-size: 0.64rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  margin-bottom: 0.75rem;
}

.mpt-stat__grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.35rem 0.75rem;
  color: var(--paper-3);
  font-family: var(--font-mono);
  font-size: 0.72rem;
}

.mpt-stat__grid strong {
  color: var(--paper-0);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.mpt-stat__weights {
  margin-top: 0.7rem;
  color: var(--paper-2);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  line-height: 1.5;
}

.matrix-scroll {
  max-height: min(68vh, 640px);
  overflow: auto;
  border: 1px solid rgba(255, 245, 230, 0.08);
  background: rgba(255, 245, 230, 0.08);
  position: relative;
}

.correlation-grid {
  display: grid;
  gap: 1px;
  background: rgba(255, 245, 230, 0.08);
}

.corner,
.axis-label,
.correlation-cell {
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.corner,
.axis-label {
  background: var(--ink-2);
}

.axis-label {
  padding: 0 0.55rem;
  color: var(--paper-2);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.06em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-label {
  justify-content: flex-start;
}

.column-label {
  color: var(--paper-3);
}

.sticky-corner {
  position: sticky;
  top: 0;
  left: 0;
  z-index: 4;
  box-shadow: 1px 1px 0 rgba(255, 245, 230, 0.1);
}

.sticky-column-label {
  position: sticky;
  top: 0;
  z-index: 3;
  box-shadow: 0 1px 0 rgba(255, 245, 230, 0.1);
}

.sticky-row-label {
  position: sticky;
  left: 0;
  z-index: 2;
  box-shadow: 1px 0 0 rgba(255, 245, 230, 0.1);
}

.correlation-cell {
  width: 100%;
  min-width: 72px;
  padding: 0 0.35rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 1100px) {
  .mpt-stat-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .frontier-chart {
    min-height: 340px;
  }

  .mpt-stat-strip {
    grid-template-columns: 1fr;
  }
}
</style>
