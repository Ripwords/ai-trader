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
const props = defineProps<{
  cash: number
  market_val: number
  total_assets: number
  positions: Position[]
  currency?: string | null
  cash_by_currency?: Record<string, number> | null
  /** Echoed by the trade_portfolio tool; the tool defaults to REAL. */
  trd_env?: 'SIMULATE' | 'REAL' | null
}>()

const envLabel = computed(() => props.trd_env === 'REAL' ? 'live' : props.trd_env === 'SIMULATE' ? 'paper' : 'account')

// Base/reporting currency for the scalar cash / market value / total assets.
// For moomoo margin accounts this is the home currency (e.g. HKD) that all
// figures are converted into — NOT necessarily a currency the user holds.
const currencyLabel = computed(() => props.currency || '')

// Native cash the user actually holds, per real currency. Preferred over the
// base-currency `cash` scalar so we never imply a phantom HKD balance.
const nativeCash = computed(() => Object.entries(props.cash_by_currency ?? {}).filter(([, v]) => v))

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
        Portfolio · {{ envLabel }}
        <span v-if="currencyLabel" class="ml-1 text-[var(--accent)]">· base {{ currencyLabel }}</span>
      </div>
      <div class="font-mono text-sm text-[var(--paper-2)]" data-mono>{{ props.positions.length }} positions</div>
    </header>

    <div class="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x hairline">
      <div class="px-4 py-3 sm:px-5 sm:py-4">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">cash</div>
        <template v-if="nativeCash.length">
          <div
            v-for="[ccy, amt] in nativeCash"
            :key="ccy"
            class="font-mono text-2xl text-[var(--paper-0)] mt-2" data-mono
          >{{ fmt(amt) }} <span class="text-sm text-[var(--paper-3)]">{{ ccy }}</span></div>
          <div v-if="currencyLabel" class="font-mono text-[10px] text-[var(--paper-3)] mt-1" data-mono>
            ≈ {{ fmt(props.cash) }} {{ currencyLabel }} base
          </div>
        </template>
        <div v-else class="font-mono text-2xl text-[var(--paper-0)] mt-2" data-mono>
          {{ fmt(props.cash) }}<span v-if="currencyLabel" class="text-sm text-[var(--paper-3)]"> {{ currencyLabel }}</span>
        </div>
      </div>
      <div class="px-4 py-3 sm:px-5 sm:py-4">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">market value<span v-if="currencyLabel"> · {{ currencyLabel }}</span></div>
        <div class="font-mono text-2xl text-[var(--paper-0)] mt-2" data-mono>{{ fmt(props.market_val) }}</div>
      </div>
      <div class="px-4 py-3 sm:px-5 sm:py-4 bg-[var(--ink-2)]">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--accent)]">total assets<span v-if="currencyLabel"> · {{ currencyLabel }}</span></div>
        <div class="font-mono text-2xl text-[var(--paper-0)] mt-2" data-mono>{{ fmt(props.total_assets) }}</div>
      </div>
    </div>

    <div v-if="props.positions.length" class="border-t hairline">
      <div class="table-scroll">
        <div class="min-w-[560px]">
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
      </div>
    </div>
    <div v-else class="px-5 py-6 text-center font-mono text-sm text-[var(--paper-3)]">no positions</div>
  </div>
</template>
