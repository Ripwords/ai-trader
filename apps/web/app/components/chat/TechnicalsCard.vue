<script setup lang="ts">
import { computed } from 'vue'

interface TechnicalSignal {
  indicator: string
  reading: string
  signal: 'bullish' | 'bearish' | 'neutral'
  detail: string
}

interface PivotLevel {
  price: number
  time: string
  distancePct: number | null
}

interface TechnicalsSnapshot {
  asOf: string | null
  lastClose: number | null
  sma20: number | null
  sma50: number | null
  sma200: number | null
  high52w: number | null
  low52w: number | null
  pctFrom52wHigh: number | null
  pctFrom52wLow: number | null
  rsi14: number | null
  return1m: number | null
  return3m: number | null
  return6m: number | null
  return1y: number | null
  avgVolume20: number | null
  trend: 'up' | 'down' | 'sideways' | null
  ema12: number | null
  ema26: number | null
  macd: { line: number | null; signal: number | null; histogram: number | null; cross: 'bullish' | 'bearish' | null }
  bollinger: { upper: number | null; mid: number | null; lower: number | null; percentB: number | null; bandwidth: number | null }
  atr14: number | null
  atrPct: number | null
  stochastic: { k: number | null; d: number | null; reading: 'overbought' | 'oversold' | 'neutral' | null }
  obv: { value: number | null; trend20: 'up' | 'down' | 'flat' | null }
  volumeVsAvg20: number | null
  smaCross: { golden: boolean; death: boolean; withinBars: number }
  support: PivotLevel[]
  resistance: PivotLevel[]
  signals: TechnicalSignal[]
  note: string | null
}

interface TechnicalAnalysisResult {
  symbol: string
  name?: string | null
  bar_count: number
  snapshot: TechnicalsSnapshot
}

const props = defineProps<{ result: TechnicalAnalysisResult | { error: string } }>()

const data = computed<TechnicalAnalysisResult | null>(() => {
  if ('snapshot' in props.result && props.result.snapshot) return props.result
  return null
})

const errorText = computed(() => {
  if ('error' in props.result) return props.result.error
  return 'technical analysis unavailable'
})

const snap = computed(() => data.value?.snapshot ?? null)

function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--'
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '--'
  return v.toFixed(digits)
}

function fmtSignedPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '--'
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
}

interface SmaRow { label: string; value: number | null; above: boolean | null }

const smaLadder = computed<SmaRow[]>(() => {
  const s = snap.value
  if (!s) return []
  const rows: Array<[string, number | null]> = [['SMA20', s.sma20], ['SMA50', s.sma50], ['SMA200', s.sma200]]
  return rows.map(([label, value]) => ({
    label,
    value,
    above: value != null && s.lastClose != null ? s.lastClose > value : null,
  }))
})
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden ta-card">
    <!-- Error / malformed shape fallback -->
    <div v-if="!data || !snap" class="ta-body">
      <p class="ta-error">{{ errorText }}</p>
    </div>

    <template v-else>
      <!-- Header -->
      <header class="ta-head">
        <div class="ta-title">
          <span class="ta-symbol">{{ data.symbol }}</span>
          <span v-if="data.name" class="ta-name">{{ data.name }}</span>
        </div>
        <div class="ta-head-right">
          <span v-if="snap.lastClose != null" class="ta-price">{{ fmtPrice(snap.lastClose) }}</span>
          <span v-if="snap.trend" class="ta-badge" :class="`trend-${snap.trend}`">{{ snap.trend }}</span>
        </div>
      </header>

      <div class="ta-body">
        <!-- Signals -->
        <div v-if="snap.signals.length" class="ta-section">
          <div class="ta-section-title">signals</div>
          <ul class="ta-signals">
            <li v-for="(s, i) in snap.signals" :key="i" class="ta-signal">
              <span class="ta-sig-badge" :class="`sig-${s.signal}`">{{ s.signal }}</span>
              <span class="ta-sig-indicator">{{ s.indicator }}</span>
              <span class="ta-sig-reading">{{ s.reading }}</span>
              <span class="ta-sig-detail">{{ s.detail }}</span>
            </li>
          </ul>
        </div>

        <!-- Key indicator readouts -->
        <div class="ta-section">
          <div class="ta-section-title">indicators</div>
          <div class="ta-stats">
            <div class="ta-stat">
              <span>rsi 14</span>
              <strong>{{ fmtNum(snap.rsi14, 1) }}</strong>
            </div>
            <div class="ta-stat">
              <span>macd hist</span>
              <strong>{{ fmtNum(snap.macd.histogram, 3) }}</strong>
            </div>
            <div class="ta-stat">
              <span>%b</span>
              <strong>{{ fmtNum(snap.bollinger.percentB, 2) }}</strong>
            </div>
            <div class="ta-stat">
              <span>atr %</span>
              <strong>{{ fmtNum(snap.atrPct, 2) }}</strong>
            </div>
            <div class="ta-stat">
              <span>stoch k / d</span>
              <strong>{{ fmtNum(snap.stochastic.k, 1) }} / {{ fmtNum(snap.stochastic.d, 1) }}</strong>
            </div>
            <div class="ta-stat">
              <span>vol vs 20d</span>
              <strong>{{ snap.volumeVsAvg20 != null ? fmtNum(snap.volumeVsAvg20, 2) + 'x' : '--' }}</strong>
            </div>
          </div>
        </div>

        <!-- SMA ladder -->
        <div v-if="smaLadder.some(r => r.value != null)" class="ta-section">
          <div class="ta-section-title">sma ladder</div>
          <div class="ta-ladder">
            <div v-for="row in smaLadder" :key="row.label" class="ta-ladder-row">
              <span class="ta-ladder-label">{{ row.label }}</span>
              <span class="ta-ladder-value">{{ fmtNum(row.value, 2) }}</span>
              <span
                v-if="row.above !== null"
                class="ta-ladder-rel"
                :class="row.above ? 'pos' : 'neg'"
              >price {{ row.above ? 'above' : 'below' }}</span>
            </div>
          </div>
          <div v-if="snap.smaCross.golden || snap.smaCross.death" class="ta-cross" :class="snap.smaCross.golden ? 'pos' : 'neg'">
            {{ snap.smaCross.golden ? 'golden cross' : 'death cross' }} within last {{ snap.smaCross.withinBars }} bars
          </div>
        </div>

        <!-- Support / resistance -->
        <div v-if="snap.resistance.length || snap.support.length" class="ta-section">
          <div class="ta-section-title">support / resistance</div>
          <div class="ta-levels">
            <div v-for="(r, i) in snap.resistance" :key="`r-${i}`" class="ta-level">
              <span class="ta-level-kind">R</span>
              <span class="ta-level-price">{{ fmtNum(r.price, 2) }}</span>
              <span class="ta-level-dist">{{ fmtSignedPct(r.distancePct) }}</span>
              <span class="ta-level-time">{{ r.time }}</span>
            </div>
            <div v-for="(s, i) in snap.support" :key="`s-${i}`" class="ta-level">
              <span class="ta-level-kind">S</span>
              <span class="ta-level-price">{{ fmtNum(s.price, 2) }}</span>
              <span class="ta-level-dist">{{ fmtSignedPct(s.distancePct) }}</span>
              <span class="ta-level-time">{{ s.time }}</span>
            </div>
          </div>
        </div>

        <!-- Footer meta / note -->
        <p v-if="snap.note" class="ta-note">{{ snap.note }}</p>
        <p class="ta-meta">
          {{ data.bar_count }} daily bars<span v-if="snap.asOf"> · as of {{ snap.asOf }}</span>
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ta-card {
  font-family: var(--font-mono);
}

/* Header */
.ta-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid rgba(255, 245, 230, 0.08);
}

.ta-title {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  min-width: 0;
}

.ta-symbol {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--paper-0, #f5f0e8);
  letter-spacing: 0.06em;
}

.ta-name {
  color: var(--paper-3, #9e9789);
  font-size: 0.68rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ta-head-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.ta-price {
  color: var(--paper-0, #f5f0e8);
  font-size: 1rem;
  font-variant-numeric: tabular-nums;
}

.ta-badge {
  font-size: 0.6rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  padding: 0.15rem 0.5rem;
  border: 1px solid currentColor;
}

.trend-up { color: var(--tape-up, #7ec99c); }
.trend-down { color: var(--tape-down, #e07a5f); }
.trend-sideways { color: var(--accent, #b09a6e); }

/* Body */
.ta-body {
  padding: 1rem;
  display: grid;
  gap: 1rem;
}

.ta-section-title {
  color: var(--paper-3, #9e9789);
  font-size: 0.62rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  margin-bottom: 0.5rem;
}

/* Signals */
.ta-signals {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.35rem;
}

.ta-signal {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  flex-wrap: wrap;
  font-size: 0.72rem;
}

.ta-sig-badge {
  font-size: 0.58rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 0.1rem 0.4rem;
  border: 1px solid currentColor;
  flex-shrink: 0;
}

.sig-bullish { color: var(--tape-up, #7ec99c); }
.sig-bearish { color: var(--tape-down, #e07a5f); }
.sig-neutral { color: var(--paper-3, #9e9789); }

.ta-sig-indicator {
  color: var(--paper-3, #9e9789);
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.ta-sig-reading {
  color: var(--paper-1, #e8dfd0);
}

.ta-sig-detail {
  color: var(--paper-3, #9e9789);
  font-size: 0.65rem;
}

/* Indicator stats grid */
.ta-stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 0.75rem;
}

.ta-stat {
  border: 1px solid rgba(255, 245, 230, 0.08);
  background: rgba(255, 245, 230, 0.025);
  padding: 0.6rem 0.75rem;
}

.ta-stat span {
  display: block;
  color: var(--paper-3, #9e9789);
  font-size: 0.6rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.ta-stat strong {
  display: block;
  margin-top: 0.4rem;
  color: var(--paper-0, #f5f0e8);
  font-size: 1rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

/* SMA ladder */
.ta-ladder {
  display: grid;
  gap: 0.25rem;
}

.ta-ladder-row {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  font-size: 0.72rem;
  color: var(--paper-1, #e8dfd0);
  font-variant-numeric: tabular-nums;
}

.ta-ladder-label {
  color: var(--paper-3, #9e9789);
  font-size: 0.62rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  width: 4.5rem;
}

.ta-ladder-value {
  min-width: 5rem;
}

.ta-ladder-rel {
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.ta-cross {
  margin-top: 0.5rem;
  font-size: 0.68rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.pos { color: var(--tape-up, #7ec99c); }
.neg { color: var(--tape-down, #e07a5f); }

/* Support / resistance */
.ta-levels {
  display: grid;
  gap: 0.25rem;
}

.ta-level {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.15rem 0.75rem;
  font-size: 0.72rem;
  color: var(--paper-1, #e8dfd0);
  font-variant-numeric: tabular-nums;
}

.ta-level-kind {
  color: var(--paper-3, #9e9789);
  font-size: 0.62rem;
  width: 1rem;
}

.ta-level-price {
  min-width: 5rem;
}

.ta-level-dist {
  color: var(--paper-3, #9e9789);
  min-width: 4rem;
}

.ta-level-time {
  color: var(--paper-3, #9e9789);
  font-size: 0.65rem;
  min-width: 0;
}

/* Note / meta / error */
.ta-note {
  margin: 0;
  color: var(--accent, #b09a6e);
  font-size: 0.68rem;
}

.ta-meta {
  margin: 0;
  color: var(--paper-3, #9e9789);
  font-size: 0.62rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.ta-error {
  margin: 0;
  color: var(--tape-down, #e07a5f);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

@media (max-width: 720px) {
  .ta-stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
