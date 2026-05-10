<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  symbol: string
  name: string | null
  last: number | null
  change: number | null
  changePct: number | null
  currency: string
  generatedAt: string
  cached: boolean
}>()

const tone = computed(() => {
  if (props.change === null) return 'neutral'
  return props.change >= 0 ? 'up' : 'down'
})

const fmtPrice = computed(() => props.last !== null ? props.last.toFixed(2) : '—')
const fmtChange = computed(() => {
  if (props.change === null) return '—'
  const sign = props.change >= 0 ? '+' : ''
  return `${sign}${props.change.toFixed(2)}`
})
const fmtPct = computed(() => {
  if (props.changePct === null) return '—'
  const sign = props.changePct >= 0 ? '+' : ''
  return `${sign}${(props.changePct * 100).toFixed(2)}%`
})

const generatedAgo = computed(() => {
  const diff = Date.now() - new Date(props.generatedAt).getTime()
  const min = Math.round(diff / 60000)
  if (min < 1) return 'moments ago'
  if (min < 60) return `${min}m ago`
  return `${Math.round(min / 60)}h ago`
})
</script>

<template>
  <header class="price-header surface-1">
    <div class="meta">
      <div class="sym" data-mono>{{ symbol }}</div>
      <div v-if="name" class="name">{{ name }}</div>
    </div>
    <div class="tape" :data-tone="tone">
      <span class="last" data-mono>{{ fmtPrice }}</span>
      <span class="ccy">{{ currency }}</span>
      <span class="sep">·</span>
      <span class="chg" data-mono>{{ fmtChange }}</span>
      <span class="pct" data-mono>{{ fmtPct }}</span>
    </div>
    <div class="ts">
      <span>{{ cached ? 'cached' : 'live' }}</span>
      <span class="dot">·</span>
      <span>moomoo</span>
      <span class="dot">·</span>
      <span>{{ generatedAgo }}</span>
    </div>
  </header>
</template>

<style scoped>
.price-header {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 0.5rem 1.5rem;
  padding: 1.1rem 1.4rem;
  border-radius: 6px;
  align-items: baseline;
}
.meta {
  grid-row: 1 / span 2;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.sym {
  font-family: var(--font-mono);
  font-size: 1.6rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-0);
  line-height: 1;
}
.name {
  font-family: var(--font-sans);
  font-size: 0.85rem;
  color: var(--paper-2);
  letter-spacing: 0.02em;
}
.tape {
  display: inline-flex;
  align-items: baseline;
  gap: 0.55rem;
  font-family: var(--font-mono);
  color: var(--paper-1);
  white-space: nowrap;
}
.tape[data-tone="up"]   .chg, .tape[data-tone="up"]   .pct { color: var(--tape-up); }
.tape[data-tone="down"] .chg, .tape[data-tone="down"] .pct { color: var(--tape-down); }
.last { font-size: 1.85rem; letter-spacing: 0.02em; }
.ccy  { font-size: 0.7rem; color: var(--paper-3); letter-spacing: 0.18em; text-transform: uppercase; }
.sep  { color: var(--paper-3); }
.chg  { font-size: 1rem; }
.pct  { font-size: 1rem; }
.ts {
  grid-column: 2;
  display: inline-flex;
  align-items: baseline;
  gap: 0.45rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  justify-self: end;
}
.ts .dot { opacity: 0.5; }
</style>
