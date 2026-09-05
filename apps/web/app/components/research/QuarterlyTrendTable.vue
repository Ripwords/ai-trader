<script setup lang="ts">
import type { QuarterlyRow } from '../../../types/research'

defineProps<{ rows: QuarterlyRow[] }>()

function fmtRev(v: number | null): string {
  if (v === null) return '—'
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  return v.toLocaleString()
}
function fmtPct(v: number | null): string {
  if (v === null) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${(v * 100).toFixed(1)}%`
}
function pctTone(v: number | null): 'up' | 'down' | 'neutral' {
  if (v === null) return 'neutral'
  return v >= 0 ? 'up' : 'down'
}
function fmtEps(v: number | null): string {
  if (v === null) return '—'
  return v.toFixed(2)
}
function fmtMargin(v: number | null): string {
  if (v === null) return '—'
  return `${(v * 100).toFixed(1)}%`
}
</script>

<template>
  <section class="qtr surface-1">
    <header class="head">
      <div class="eyebrow">quarterly trend</div>
      <div class="count" data-mono>{{ rows.length }} quarters</div>
    </header>
    <div v-if="rows.length === 0" class="empty">no quarterly data available</div>
    <div v-else class="table-scroll">
      <table>
        <thead>
          <tr>
            <th class="th-period">period</th>
            <th class="th-num">revenue</th>
            <th class="th-num">yoy</th>
            <th class="th-num">eps</th>
            <th class="th-num">yoy</th>
            <th class="th-num">op margin</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="i">
            <td class="period">{{ r.period }}</td>
            <td class="num" data-mono>{{ fmtRev(r.revenue) }}</td>
            <td class="num" data-mono :data-tone="pctTone(r.revenue_yoy)">{{ fmtPct(r.revenue_yoy) }}</td>
            <td class="num" data-mono>{{ fmtEps(r.eps) }}</td>
            <td class="num" data-mono :data-tone="pctTone(r.eps_yoy)">{{ fmtPct(r.eps_yoy) }}</td>
            <td class="num" data-mono>{{ fmtMargin(r.margin) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.qtr {
  border-radius: 6px;
  overflow: hidden;
}
.head {
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
.count {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  color: var(--paper-3);
  letter-spacing: 0.18em;
}
table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); }
th {
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  font-weight: 500;
  color: var(--paper-3);
  text-align: left;
  padding: 0.65rem 1.2rem;
  border-bottom: 1px solid var(--ink-line);
}
.th-num { text-align: right; }
td {
  padding: 0.7rem 1.2rem;
  border-bottom: 1px solid var(--ink-line);
  font-size: 0.85rem;
}
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--ink-2); }
.period { color: var(--paper-1); letter-spacing: 0.04em; }
.num { text-align: right; color: var(--paper-1); }
.num[data-tone="up"]   { color: var(--tape-up); }
.num[data-tone="down"] { color: var(--tape-down); }

.empty {
  padding: 2rem 1.2rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-3);
  text-align: center;
  letter-spacing: 0.04em;
}

@media (max-width: 640px) {
  .head { padding: 1rem 0.6rem; }
  .empty { padding: 2rem 0.6rem; }
  th { padding: 0.65rem 0.6rem; }
  td { padding: 0.7rem 0.6rem; }
}
</style>
