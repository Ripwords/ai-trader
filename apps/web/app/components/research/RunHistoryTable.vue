<script setup lang="ts">
import type { Rating } from '../../../types/agents'

interface Row {
  id: string
  symbol: string
  tradeDate: string
  status: string
  rating?: Rating | string | null
  confidence?: number | null
  alpha?: number | string | null
  outcome?: string | null
  costUsd?: number | string | null
  durationSec?: number | null
  startedAt?: string | null
  finishedAt?: string | null
  model?: string | null
}

const props = defineProps<{ rows: Row[] }>()

function ratingTone(r?: Rating | string | null): 'up' | 'down' | 'neutral' {
  if (!r) return 'neutral'
  const v = String(r).toLowerCase()
  if (v === 'strong-buy' || v === 'buy') return 'up'
  if (v === 'reduce' || v === 'sell') return 'down'
  return 'neutral'
}

function alphaTone(a?: number | string | null): 'up' | 'down' | 'neutral' {
  if (a === null || a === undefined) return 'neutral'
  const n = typeof a === 'number' ? a : Number(a)
  if (!Number.isFinite(n)) return 'neutral'
  return n > 0 ? 'up' : n < 0 ? 'down' : 'neutral'
}

function fmtAlpha(a?: number | string | null): string {
  if (a === null || a === undefined) return '—'
  const n = typeof a === 'number' ? a : Number(a)
  if (!Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${(n * 100).toFixed(2)}%`
}

function fmtCost(c?: number | string | null): string {
  if (c === null || c === undefined) return '—'
  const n = typeof c === 'number' ? c : Number(c)
  if (!Number.isFinite(n)) return '—'
  return `$${n.toFixed(2)}`
}

function fmtDuration(row: Row): string {
  if (typeof row.durationSec === 'number') {
    if (row.durationSec < 60) return `${row.durationSec}s`
    return `${(row.durationSec / 60).toFixed(1)}m`
  }
  if (row.startedAt && row.finishedAt) {
    const ms = new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime()
    if (Number.isFinite(ms) && ms > 0) {
      const s = Math.round(ms / 1000)
      if (s < 60) return `${s}s`
      return `${(s / 60).toFixed(1)}m`
    }
  }
  return '—'
}

function fmtConfidence(c?: number | null): string {
  if (c === null || c === undefined) return '—'
  return `${c}%`
}

function rowClick(row: Row) {
  navigateTo({ path: '/research/' + row.symbol, query: { run: row.id } })
}
</script>

<template>
  <section class="history surface-1">
    <header class="head">
      <span class="eyebrow">run history</span>
      <span class="count" data-mono>{{ props.rows.length }} runs</span>
    </header>
    <div v-if="props.rows.length === 0" class="empty">no agent runs yet</div>
    <table v-else>
      <thead>
        <tr>
          <th>date</th>
          <th>symbol</th>
          <th>rating</th>
          <th class="th-num">conf.</th>
          <th class="th-num">alpha</th>
          <th class="th-num">cost</th>
          <th class="th-num">dur.</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in props.rows"
          :key="r.id"
          @click="rowClick(r)"
        >
          <td class="date">{{ r.tradeDate }}</td>
          <td class="symbol" data-mono>{{ r.symbol }}</td>
          <td>
            <span class="rating-chip" :data-tone="ratingTone(r.rating)" data-mono>
              {{ r.rating ?? '—' }}
            </span>
          </td>
          <td class="num" data-mono>{{ fmtConfidence(r.confidence ?? null) }}</td>
          <td class="num" data-mono :data-tone="alphaTone(r.alpha)">{{ fmtAlpha(r.alpha) }}</td>
          <td class="num" data-mono>{{ fmtCost(r.costUsd) }}</td>
          <td class="num" data-mono>{{ fmtDuration(r) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.history {
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
tbody tr { cursor: pointer; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--ink-2); }
.date { color: var(--paper-2); letter-spacing: 0.04em; }
.symbol { color: var(--paper-0); letter-spacing: 0.06em; }
.num { text-align: right; color: var(--paper-1); }
.num[data-tone="up"]   { color: var(--tape-up); }
.num[data-tone="down"] { color: var(--tape-down); }

.rating-chip {
  display: inline-block;
  padding: 0.18rem 0.5rem;
  border-radius: 3px;
  border: 1px solid var(--ink-line);
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--paper-2);
}
.rating-chip[data-tone="up"]      { color: var(--tape-up); border-color: color-mix(in srgb, var(--tape-up) 35%, transparent); }
.rating-chip[data-tone="down"]    { color: var(--tape-down); border-color: color-mix(in srgb, var(--tape-down) 35%, transparent); }
.rating-chip[data-tone="neutral"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }

.empty {
  padding: 2rem 1.2rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-3);
  text-align: center;
  letter-spacing: 0.04em;
}
</style>
