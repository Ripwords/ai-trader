<script setup lang="ts">
interface OrderResult {
  order_id: string
  code: string
  side: 'BUY' | 'SELL'
  qty: number
  price: number
  status: string
  trd_env: 'SIMULATE' | 'REAL'
  acc_id: string
}

const props = defineProps<{ result: OrderResult }>()

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
}
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 py-3 border-b hairline flex items-baseline justify-between">
      <div class="flex items-baseline gap-3">
        <div class="font-mono text-xs uppercase tracking-[0.2em]"
          :class="props.result.trd_env === 'REAL' ? 'text-[var(--tape-down)]' : 'text-[var(--paper-3)]'">
          Order · {{ props.result.trd_env === 'REAL' ? 'LIVE' : 'paper' }}
        </div>
        <div class="font-mono text-xs uppercase tracking-[0.18em]"
          :class="props.result.side === 'BUY' ? 'tape-up' : 'tape-down'">
          {{ props.result.side }}
        </div>
      </div>
      <div class="font-mono text-xs text-[var(--paper-3)]" data-mono>
        #{{ props.result.order_id }}
      </div>
    </header>

    <div class="grid grid-cols-2 sm:grid-cols-4 hairline">
      <div class="px-4 py-3 sm:px-5 sm:border-r">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">code</div>
        <div class="font-mono text-base text-[var(--paper-0)] mt-1.5" data-mono>{{ props.result.code }}</div>
      </div>
      <div class="px-4 py-3 sm:px-5 border-l sm:border-l-0 sm:border-r">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">qty</div>
        <div class="font-mono text-base text-[var(--paper-0)] mt-1.5" data-mono>{{ props.result.qty }}</div>
      </div>
      <div class="px-4 py-3 sm:px-5 border-t sm:border-t-0 sm:border-r">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">price</div>
        <div class="font-mono text-base text-[var(--paper-0)] mt-1.5" data-mono>{{ fmt(props.result.price) }}</div>
      </div>
      <div class="px-4 py-3 sm:px-5 bg-[var(--ink-2)] border-l border-t sm:border-l-0 sm:border-t-0">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--accent)]">status</div>
        <div class="font-mono text-base text-[var(--paper-0)] mt-1.5" data-mono>{{ props.result.status }}</div>
      </div>
    </div>
  </div>
</template>
