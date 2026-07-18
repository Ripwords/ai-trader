<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  toolName: string
  state?: string
  streaming?: boolean
}>()

const labels: Record<string, string> = {
  market_kline: 'Loading chart data',
  market_snapshot: 'Fetching quote',
  watchlist_list: 'Loading watchlist',
  watchlist_add: 'Updating watchlist',
  watchlist_remove: 'Updating watchlist',
  search_web: 'Searching web',
  search_news: 'Searching news',
  trade_accounts: 'Checking accounts',
  portfolio_mpt_analysis: 'Loading MPT analysis',
  trade_portfolio: 'Loading broker portfolio',
  trade_orders: 'Loading orders',
  trade_fills: 'Loading fills',
  trade_place_order: 'Submitting order',
  trade_modify_order: 'Modifying order',
  trade_cancel_order: 'Cancelling order',
  algo_list: 'Loading strategies',
  algo_backtest: 'Running backtest',
  algo_recent_signals: 'Loading recent signals',
  algo_state: 'Checking algo state',
  algo_kill: 'Stopping algos',
  algo_unkill: 'Resuming algos',
  agents_debate: 'Running agents debate',
  holdings_context: 'Reconciling holdings',
  convert_fx: 'Converting currency',
  usage_summary: 'Loading usage',
  alert_create: 'Arming price alert',
  alert_list: 'Loading price alerts',
  alert_cancel: 'Cancelling price alert',
}

const label = computed(() => labels[props.toolName] ?? `Running ${props.toolName}`)
const statusText = computed(() => {
  if (props.streaming) return 'running'
  if (props.state === 'output-available') return 'complete'
  if (props.state === 'input-streaming' || props.state === 'input-available') return 'queued'
  if (props.state === 'output-error') return 'failed'
  return 'working'
})
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <div class="px-5 py-4 flex items-center justify-between gap-4">
      <div class="min-w-0">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
          {{ toolName }}
        </div>
        <div class="mt-1 text-sm text-[var(--paper-1)] truncate">
          {{ label }}
        </div>
      </div>
      <div class="shrink-0 flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em] text-[var(--paper-3)]">
        <span
          class="size-2 rounded-full"
          :class="state === 'output-error'
            ? 'bg-[var(--tape-down)]'
            : state === 'output-available' && !streaming
              ? 'bg-[var(--paper-3)]'
              : 'bg-[var(--accent)] dot-pulse'"
        />
        {{ statusText }}
      </div>
    </div>
    <div v-if="streaming || (state !== 'output-error' && state !== 'output-available')" class="h-px bg-[var(--ink-2)] overflow-hidden">
      <div class="tool-progress h-full bg-[var(--accent)]" />
    </div>
  </div>
</template>

<style scoped>
@keyframes tool-progress {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(260%); }
}

.tool-progress {
  width: 38%;
  animation: tool-progress 1.35s ease-in-out infinite;
}
</style>
