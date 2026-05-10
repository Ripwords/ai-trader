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

function statusTone(s: string): 'up' | 'down' | 'neutral' | 'pending' {
  if (s === 'complete') return 'neutral'
  if (s === 'failed') return 'down'
  if (s === 'running') return 'pending'
  if (s === 'cancelled') return 'neutral'
  return 'neutral'
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
  if (n < 0.01) return `$${n.toFixed(4)}`
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
  if (c === null || c === undefined) return ''
  return `${c}%`
}

function shortDate(s: string): string {
  // Compact form for the aside: "May 10" / "May 10, 2026" only when not
  // current year. Trade dates are stored as ISO yyyy-mm-dd so we can
  // synthesise without a Date round-trip.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return s
  const [, year, month, day] = m
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthName = months[Number(month) - 1] ?? month
  const thisYear = String(new Date().getFullYear())
  return year === thisYear ? `${monthName} ${Number(day)}` : `${monthName} ${Number(day)}, ${year}`
}

function rowClick(row: Row) {
  navigateTo({ path: '/research/' + row.symbol, query: { run: row.id } })
}
</script>

<template>
  <ol v-if="props.rows.length > 0" class="history">
    <li
      v-for="r in props.rows"
      :key="r.id"
      class="row"
      :data-status="r.status"
      tabindex="0"
      role="button"
      @click="rowClick(r)"
      @keydown.enter="rowClick(r)"
      @keydown.space.prevent="rowClick(r)"
    >
      <!-- Top line: date + rating chip with confidence inside it. -->
      <div class="row__lead">
        <span class="row__date" data-mono>{{ shortDate(r.tradeDate) }}</span>
        <span
          class="row__rating"
          :data-tone="ratingTone(r.rating)"
          data-mono
        >
          <span v-if="r.rating">{{ r.rating }}</span>
          <span v-else class="row__rating-pending">{{ r.status === 'running' ? '…' : '—' }}</span>
          <span
            v-if="r.confidence !== null && r.confidence !== undefined"
            class="row__conf"
            data-mono
          >{{ fmtConfidence(r.confidence) }}</span>
        </span>
      </div>

      <!-- Bottom line: symbol on left, status meta on right. -->
      <div class="row__meta">
        <span class="row__symbol" data-mono>{{ r.symbol }}</span>
        <span class="row__sep" aria-hidden="true">·</span>

        <!-- Reflected runs surface alpha/outcome; otherwise dur+cost. -->
        <template v-if="r.alpha !== null && r.alpha !== undefined">
          <span class="row__alpha" :data-tone="alphaTone(r.alpha)" data-mono>
            {{ fmtAlpha(r.alpha) }}
          </span>
          <span v-if="r.outcome" class="row__outcome" data-mono>
            {{ r.outcome }}
          </span>
        </template>
        <template v-else>
          <span class="row__cost" data-mono>{{ fmtCost(r.costUsd) }}</span>
          <span class="row__dur" data-mono>{{ fmtDuration(r) }}</span>
        </template>

        <span
          class="row__status"
          :data-tone="statusTone(r.status)"
          data-mono
        >{{ r.status }}</span>
      </div>
    </li>
  </ol>

  <p v-else class="empty" data-mono>no agent runs yet</p>
</template>

<style scoped>
/* The aside column is narrow (~330px); a wide tabular layout always
   truncated half its columns. Each run is rendered as a two-line stacked
   card instead — readable in the aside, still scannable as a list, and
   click-anywhere navigates. */

.history {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.7rem 0.2rem;
  border-bottom: 1px solid var(--ink-line);
  cursor: pointer;
  outline: none;
  transition: background-color 140ms ease, padding-left 140ms ease;
  position: relative;
}
.row::before {
  content: "";
  position: absolute;
  left: -2px; top: 50%;
  width: 2px; height: 0;
  background: var(--accent);
  transition: height 140ms ease, top 140ms ease;
}
.row:hover {
  background: rgba(255, 245, 230, 0.018);
  padding-left: 0.6rem;
}
.row:hover::before { height: 60%; top: 20%; }
.row:focus-visible {
  background: rgba(255, 245, 230, 0.018);
  padding-left: 0.6rem;
  outline: 1px solid var(--ink-line-strong);
  outline-offset: -1px;
}
.row[data-status="running"] {
  background: linear-gradient(90deg, rgba(212, 169, 106, 0.04) 0%, transparent 70%);
}

.row__lead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.6rem;
}
.row__date {
  font-size: 0.7rem;
  color: var(--paper-3);
  letter-spacing: 0.04em;
}
.row__rating {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
  padding: 0.18rem 0.5rem;
  border-radius: 3px;
  border: 1px solid var(--ink-line);
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--paper-2);
}
.row__rating[data-tone="up"]      { color: var(--tape-up); border-color: color-mix(in srgb, var(--tape-up) 35%, transparent); }
.row__rating[data-tone="down"]    { color: var(--tape-down); border-color: color-mix(in srgb, var(--tape-down) 35%, transparent); }
.row__rating[data-tone="neutral"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.row__rating-pending { color: var(--paper-3); }
.row__conf {
  font-size: 0.66rem;
  color: currentColor;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

.row__meta {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  font-size: 0.7rem;
  color: var(--paper-3);
  flex-wrap: wrap;
}
.row__symbol {
  color: var(--paper-1);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-weight: 500;
}
.row__sep { color: var(--ink-line-strong); }
.row__alpha { font-variant-numeric: tabular-nums; }
.row__alpha[data-tone="up"]      { color: var(--tape-up); }
.row__alpha[data-tone="down"]    { color: var(--tape-down); }
.row__alpha[data-tone="neutral"] { color: var(--paper-2); }
.row__outcome {
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.6rem;
  color: var(--paper-3);
}
.row__cost,
.row__dur {
  color: var(--paper-2);
  font-variant-numeric: tabular-nums;
}
.row__status {
  margin-left: auto;
  font-size: 0.6rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.row__status[data-tone="up"]      { color: var(--tape-up); }
.row__status[data-tone="down"]    { color: var(--tape-down); }
.row__status[data-tone="pending"] { color: var(--accent); }

.empty {
  margin: 0;
  padding: 2rem 0.4rem;
  font-size: 0.78rem;
  color: var(--paper-3);
  text-align: center;
  letter-spacing: 0.04em;
}
</style>
