<script setup lang="ts">
interface Position {
  code: string
  qty: number
  cost_price: number
  current_price: number
  market_val: number
  pl_val: number
  pl_ratio: number
  currency?: string | null
}
const props = defineProps<{ cash: number; market_val: number; total_assets: number; positions: Position[]; currency?: string | null }>()

// Account settlement currency for the cash / market value / total assets
// figures. Shown so the numbers are never read as an implicit USD.
const currencyLabel = computed(() => props.currency || '')

function fmt(n: number, opts: Intl.NumberFormatOptions = {}): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2, ...opts })
}
function fmtSigned(n: number): string {
  return (n >= 0 ? '+' : '') + fmt(n)
}
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 py-4 border-b hairline flex items-baseline justify-between">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
        Portfolio · paper
        <span v-if="currencyLabel" class="ml-1 text-[var(--accent)]">· {{ currencyLabel }}</span>
      </div>
      <div class="font-mono text-sm text-[var(--paper-2)]" data-mono>{{ props.positions.length }} positions</div>
    </header>

    <div class="grid grid-cols-3 divide-x hairline">
      <div class="px-5 py-4">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">cash</div>
        <div class="font-mono text-2xl text-[var(--paper-0)] mt-2" data-mono>{{ fmt(props.cash) }}</div>
      </div>
      <div class="px-5 py-4">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">market value</div>
        <div class="font-mono text-2xl text-[var(--paper-0)] mt-2" data-mono>{{ fmt(props.market_val) }}</div>
      </div>
      <div class="px-5 py-4 bg-[var(--ink-2)]">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--accent)]">total assets<span v-if="currencyLabel"> · {{ currencyLabel }}</span></div>
        <div class="font-mono text-2xl text-[var(--paper-0)] mt-2" data-mono>{{ fmt(props.total_assets) }}</div>
      </div>
    </div>

    <div v-if="props.positions.length" class="border-t hairline">
      <div class="grid grid-cols-[1.4fr_0.6fr_0.9fr_0.9fr_1.2fr] gap-3 px-5 py-3 font-mono text-xs uppercase tracking-[0.15em] text-[var(--paper-3)] border-b hairline">
        <div>code</div>
        <div class="text-right">qty</div>
        <div class="text-right">avg</div>
        <div class="text-right">last</div>
        <div class="text-right">p/l</div>
      </div>
      <div>
        <div
          v-for="p in props.positions"
          :key="p.code"
          class="grid grid-cols-[1.4fr_0.6fr_0.9fr_0.9fr_1.2fr] gap-3 px-5 py-2.5 border-b hairline last:border-b-0 hover:bg-[var(--ink-2)] transition-colors items-baseline"
        >
          <div class="font-mono text-base text-[var(--paper-0)]">{{ p.code }}</div>
          <div class="font-mono text-base text-[var(--paper-2)] text-right" data-mono>{{ p.qty }}</div>
          <div class="font-mono text-base text-[var(--paper-2)] text-right" data-mono>{{ fmt(p.cost_price) }}</div>
          <div class="font-mono text-base text-[var(--paper-0)] text-right" data-mono>{{ fmt(p.current_price) }}</div>
          <div class="font-mono text-base text-right" :class="p.pl_val >= 0 ? 'tape-up' : 'tape-down'" data-mono>
            {{ fmtSigned(p.pl_val) }}
            <span class="text-sm opacity-70">({{ fmtSigned(p.pl_ratio * 100) }}%)</span>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="px-5 py-6 text-center font-mono text-sm text-[var(--paper-3)]">no positions</div>
  </div>
</template>
