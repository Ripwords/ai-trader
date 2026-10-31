<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  toolName: string
  state?: string
  streaming?: boolean
  /** Why the call failed; shown under the card. */
  errorText?: string
}>()

const labels: Record<string, string> = {
  market_kline: 'Loading chart data',
  market_snapshot: 'Fetching quote',
  watchlist_list: 'Loading watchlist',
  watchlist_add: 'Updating watchlist',
  watchlist_remove: 'Updating watchlist',
  search_web: 'Searching web',
  search_news: 'Searching news',
  news_pulse: 'Gathering stock news',
  trade_accounts: 'Checking accounts',
  trade_account_overview: 'Loading account overview',
  portfolio_mpt_analysis: 'Loading MPT analysis',
  investment_portfolio: 'Loading investments',
  investment_performance: 'Loading investment history',
  portfolio_performance: 'Loading net-worth history',
  planning_get: 'Loading your plan',
  planning_update: 'Updating your plan',
  portfolio_rebalance_plan: 'Working out rebalance trades',
  value_stock: 'Running valuation',
  value_screen: 'Screening watchlist',
  technical_analysis: 'Computing technicals',
  investment_research: 'Building research dossier',
  thesis_tracker: 'Loading thesis history',
  dyp_ask: 'Gathering context',
  research_start: 'Starting research run',
  research_get: 'Loading research verdict',
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
  reminder_create: 'Scheduling reminder',
  reminder_list: 'Loading reminders',
  reminder_cancel: 'Cancelling reminder',
}

const label = computed(() => labels[props.toolName] ?? `Running ${props.toolName}`)

const PAST: Record<string, string> = {
  Loading: 'Loaded', Fetching: 'Fetched', Searching: 'Searched', Running: 'Ran', Computing: 'Computed',
  Building: 'Built', Gathering: 'Gathered', Starting: 'Started', Submitting: 'Submitted', Modifying: 'Modified',
  Cancelling: 'Cancelled', Checking: 'Checked', Stopping: 'Stopped', Resuming: 'Resumed', Reconciling: 'Reconciled',
  Converting: 'Converted', Arming: 'Armed', Scheduling: 'Scheduled', Updating: 'Updated', Screening: 'Screened',
}
const doneLabel = computed(() => {
  const [verb, ...rest] = label.value.split(' ')
  return [PAST[verb!] ?? verb, ...rest].join(' ')
})
// A finished call is a step, not a result: one quiet line, like a step list.
const done = computed(() => props.state === 'output-available' && !props.streaming)
const statusText = computed(() => {
  if (props.streaming) return 'running'
  if (props.state === 'output-available') return 'complete'
  if (props.state === 'input-streaming' || props.state === 'input-available') return 'queued'
  if (props.state === 'output-error') return 'failed'
  return 'working'
})
</script>

<template>
  <div
    v-if="done"
    data-testid="tool-done"
    class="flex items-center gap-2 text-sm text-[var(--paper-3)]"
  >
    <UIcon name="i-lucide-check" class="size-4 shrink-0" />
    <span class="text-[var(--paper-2)]">{{ doneLabel }}</span>
    <span class="font-mono truncate">{{ toolName }}</span>
  </div>
  <div v-else class="surface-1 rounded-md overflow-hidden">
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
    <p
      v-if="state === 'output-error' && errorText"
      class="px-5 pb-4 -mt-1 text-sm text-[var(--paper-1)] whitespace-pre-wrap"
    >
      {{ errorText }}
    </p>
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
