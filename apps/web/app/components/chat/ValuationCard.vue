<script setup lang="ts">
interface MultiplesBlock {
  pe: string | number | null
  pb: string | number | null
  ps: string | number | null
  p_fcf: string | number | null
}

interface Scenario {
  name: string
  growth: string | number
  fair_value: string | number
  probability: string | number
}

interface AssumptionsUsed {
  growth_rates: (string | number)[]
  discount_rate: string | number
  terminal_growth: string | number
}

interface ValuationResult {
  symbol: string
  current_price: string | number
  fair_value: string | number | null
  margin_of_safety_pct: string | number | null
  scenarios: Scenario[]
  reverse_dcf_implied_growth: string | number | null
  multiples: MultiplesBlock | null
  historical_multiples: MultiplesBlock | null
  assumptions_used: AssumptionsUsed | null
  data_quality: 'full' | 'multiples_only' | 'unavailable'
  veto: {
    triggered: boolean
    reason: string | null
    rating_cap: string | null
  }
  warnings: string[]
}

const props = defineProps<{ result: ValuationResult }>()

function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtPrice(v: string | number | null | undefined): string {
  const n = toNum(v)
  if (n === null) return '--'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtPct(v: string | number | null | undefined, digits = 1): string {
  const n = toNum(v)
  if (n === null) return '--'
  return `${(n * 100).toFixed(digits)}%`
}

function fmtMult(v: string | number | null | undefined): string {
  const n = toNum(v)
  if (n === null) return '--'
  return n.toFixed(1) + 'x'
}

function mosClass(v: string | number | null | undefined): string {
  const n = toNum(v)
  if (n === null) return ''
  return n >= 0 ? 'pos' : 'neg'
}
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden val-card">
    <!-- Veto Banner (prominent, shown when triggered) -->
    <div v-if="result?.veto?.triggered" class="veto-banner" role="alert">
      <span class="veto-label">veto</span>
      <span class="veto-reason">{{ result.veto.reason }}</span>
      <span v-if="result.veto.rating_cap" class="veto-cap">cap: {{ result.veto.rating_cap }}</span>
    </div>

    <!-- Error / malformed shape fallback -->
    <div v-if="!result?.veto" class="val-body">
      <p class="val-empty-label">{{ (result as any)?.error ?? 'valuation unavailable' }}</p>
    </div>

    <!-- Header -->
    <header v-if="result?.veto" class="val-head">
      <div class="val-symbol">{{ result.symbol }}</div>
      <span class="val-badge" :class="`badge-${result.data_quality}`">{{ result.data_quality }}</span>
    </header>

    <div v-if="result?.veto" class="val-body">
      <!-- Unavailable / partial state -->
      <div v-if="result.data_quality === 'unavailable'" class="val-empty">
        <p class="val-empty-label">data quality: unavailable</p>
        <ul v-if="result.warnings.length" class="val-warnings">
          <li v-for="(w, i) in result.warnings" :key="i">{{ w }}</li>
        </ul>
      </div>

      <!-- Fair value vs price block -->
      <div v-if="result.data_quality !== 'unavailable'" class="val-prices">
        <div class="val-stat">
          <span>current price</span>
          <strong>${{ fmtPrice(result.current_price) }}</strong>
        </div>
        <div class="val-stat">
          <span>fair value</span>
          <strong>{{ result.fair_value !== null ? '$' + fmtPrice(result.fair_value) : '--' }}</strong>
        </div>
        <div class="val-stat">
          <span>margin of safety</span>
          <strong :class="mosClass(result.margin_of_safety_pct)">
            {{ fmtPct(result.margin_of_safety_pct) }}
          </strong>
        </div>
        <div v-if="result.reverse_dcf_implied_growth !== null" class="val-stat">
          <span>implied growth (rev. DCF)</span>
          <strong>{{ fmtPct(result.reverse_dcf_implied_growth) }}</strong>
        </div>
      </div>

      <!-- Scenarios table -->
      <div v-if="result.scenarios.length" class="val-section">
        <div class="val-section-title">scenarios</div>
        <table class="val-table">
          <thead>
            <tr>
              <th>name</th>
              <th>growth</th>
              <th>fair value</th>
              <th>probability</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in result.scenarios" :key="i">
              <td>{{ s.name }}</td>
              <td>{{ fmtPct(s.growth) }}</td>
              <td>${{ fmtPrice(s.fair_value) }}</td>
              <td>{{ fmtPct(s.probability) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Multiples block -->
      <div v-if="result.multiples" class="val-section">
        <div class="val-section-title">multiples</div>
        <div class="val-mults">
          <div v-if="result.multiples.pe !== null" class="val-mult">
            <span>P/E</span><strong>{{ fmtMult(result.multiples.pe) }}</strong>
          </div>
          <div v-if="result.multiples.pb !== null" class="val-mult">
            <span>P/B</span><strong>{{ fmtMult(result.multiples.pb) }}</strong>
          </div>
          <div v-if="result.multiples.ps !== null" class="val-mult">
            <span>P/S</span><strong>{{ fmtMult(result.multiples.ps) }}</strong>
          </div>
          <div v-if="result.multiples.p_fcf !== null" class="val-mult">
            <span>P/FCF</span><strong>{{ fmtMult(result.multiples.p_fcf) }}</strong>
          </div>
        </div>
        <div v-if="result.historical_multiples" class="val-hist-mults">
          <span class="val-mult-label">historical avg —</span>
          <span v-if="result.historical_multiples.pe !== null">P/E {{ fmtMult(result.historical_multiples.pe) }}</span>
          <span v-if="result.historical_multiples.pb !== null">P/B {{ fmtMult(result.historical_multiples.pb) }}</span>
          <span v-if="result.historical_multiples.ps !== null">P/S {{ fmtMult(result.historical_multiples.ps) }}</span>
          <span v-if="result.historical_multiples.p_fcf !== null">P/FCF {{ fmtMult(result.historical_multiples.p_fcf) }}</span>
        </div>
      </div>

      <!-- Assumptions -->
      <div v-if="result.assumptions_used" class="val-section val-assumptions">
        <div class="val-section-title">assumptions</div>
        <span>discount {{ fmtPct(result.assumptions_used.discount_rate) }}</span>
        <span>terminal {{ fmtPct(result.assumptions_used.terminal_growth) }}</span>
        <span>growth rates {{ result.assumptions_used.growth_rates.map(r => fmtPct(r)).join(' / ') }}</span>
      </div>

      <!-- Warnings (non-unavailable) -->
      <ul v-if="result.warnings.length && result.data_quality !== 'unavailable'" class="val-warnings">
        <li v-for="(w, i) in result.warnings" :key="i">{{ w }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.val-card {
  font-family: var(--font-mono);
}

/* Veto banner */
.veto-banner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 1.1rem;
  background: rgba(224, 122, 95, 0.18);
  border-bottom: 1px solid rgba(224, 122, 95, 0.4);
  flex-wrap: wrap;
}

.veto-label {
  text-transform: uppercase;
  font-size: 0.62rem;
  letter-spacing: 0.2em;
  font-weight: 700;
  color: var(--tape-down, #e07a5f);
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--tape-down, #e07a5f);
}

.veto-reason {
  color: var(--paper-1, #e8dfd0);
  font-size: 0.72rem;
  flex: 1;
}

.veto-cap {
  font-size: 0.62rem;
  color: var(--paper-3, #9e9789);
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

/* Header */
.val-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid rgba(255, 245, 230, 0.08);
}

.val-symbol {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--paper-0, #f5f0e8);
  letter-spacing: 0.06em;
}

.val-badge {
  font-size: 0.6rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  padding: 0.15rem 0.5rem;
  border: 1px solid currentColor;
}

.badge-full {
  color: var(--tape-up, #7ec99c);
}

.badge-multiples_only {
  color: var(--accent, #b09a6e);
}

.badge-unavailable {
  color: var(--tape-down, #e07a5f);
}

/* Body */
.val-body {
  padding: 1rem;
  display: grid;
  gap: 1rem;
}

/* Price stats row */
.val-prices {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 0.75rem;
}

.val-stat {
  border: 1px solid rgba(255, 245, 230, 0.08);
  background: rgba(255, 245, 230, 0.025);
  padding: 0.75rem 0.85rem;
}

.val-stat span {
  display: block;
  color: var(--paper-3, #9e9789);
  font-size: 0.6rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.val-stat strong {
  display: block;
  margin-top: 0.45rem;
  color: var(--paper-0, #f5f0e8);
  font-size: 1.15rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.val-stat strong.pos {
  color: var(--tape-up, #7ec99c);
}

.val-stat strong.neg {
  color: var(--tape-down, #e07a5f);
}

/* Section heading */
.val-section-title {
  color: var(--paper-3, #9e9789);
  font-size: 0.62rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  margin-bottom: 0.5rem;
}

/* Scenarios table */
.val-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.72rem;
}

.val-table th {
  color: var(--paper-3, #9e9789);
  font-size: 0.6rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  text-align: left;
  padding: 0.25rem 0.5rem 0.35rem;
  border-bottom: 1px solid rgba(255, 245, 230, 0.08);
  font-weight: 400;
}

.val-table td {
  padding: 0.35rem 0.5rem;
  color: var(--paper-1, #e8dfd0);
  border-bottom: 1px solid rgba(255, 245, 230, 0.04);
  font-variant-numeric: tabular-nums;
}

/* Multiples */
.val-mults {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.val-mult {
  border: 1px solid rgba(255, 245, 230, 0.08);
  background: rgba(255, 245, 230, 0.025);
  padding: 0.5rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.val-mult span {
  color: var(--paper-3, #9e9789);
  font-size: 0.6rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.val-mult strong {
  color: var(--paper-0, #f5f0e8);
  font-size: 1rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.val-hist-mults {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  margin-top: 0.5rem;
  color: var(--paper-3, #9e9789);
  font-size: 0.68rem;
}

.val-mult-label {
  color: var(--paper-3, #9e9789);
  font-style: italic;
}

/* Assumptions */
.val-assumptions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  color: var(--paper-3, #9e9789);
  font-size: 0.68rem;
}

/* Empty state */
.val-empty {
  padding: 0.5rem 0;
}

.val-empty-label {
  margin: 0 0 0.5rem;
  color: var(--tape-down, #e07a5f);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

/* Warnings */
.val-warnings {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 0.25rem;
}

.val-warnings li {
  color: var(--paper-3, #9e9789);
  font-size: 0.68rem;
  padding-left: 1rem;
  position: relative;
}

.val-warnings li::before {
  content: '—';
  position: absolute;
  left: 0;
}

@media (max-width: 720px) {
  .val-prices {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
