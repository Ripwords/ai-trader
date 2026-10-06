<script setup lang="ts">
import { computed } from 'vue'
import type { AllocationRow, PlanningSeverity, PlanningSnapshot, PlanningSummary } from '../../../server/lib/planning'
import { fmtCurrency, pnlTone } from '../../utils/portfolio-view'

const props = defineProps<{
  planning: PlanningSummary
  history: PlanningSnapshot[]
  historyError: boolean
  historySaving: boolean
  historyMessage: string
}>()
const emit = defineEmits<{ capture: [], edit: [] }>()

const ccy = computed(() => props.planning.base_currency)
const driftRows = computed(() => props.planning.allocation_rows.filter(r => r.target_pct > 0 || r.current_value > 0))
const recent = computed(() => [...props.history].slice(-5).reverse())

const SEVERITY_CLASS: Record<PlanningSeverity, string> = {
  ok: 'text-[var(--paper-3)]',
  watch: 'text-[var(--paper-1)]',
  alert: 'text-[var(--accent)]',
  critical: 'text-[var(--tape-down)]',
}
const ACTION_CLASS: Record<AllocationRow['action'], string> = {
  buy: 'tape-up',
  sell: 'tape-down',
  hold: 'text-[var(--paper-3)]',
}
const actionLabel = (row: AllocationRow) => row.action === 'hold' ? 'hold' : `${row.action} ${fmtCurrency(Math.abs(row.action_value), ccy.value)}`
const savingsRate = computed(() => {
  const r = props.planning.cashflow.savings_rate_pct
  return r == null ? '—' : `${r.toFixed(1)}%`
})
</script>

<template>
  <div class="space-y-6">
    <section class="surface-1 p-4 sm:p-6 grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-5">
      <StatTile label="adjusted net worth" class="col-span-2 lg:col-span-1" :value="fmtCurrency(planning.net_worth_adjusted, ccy)" sub="after liabilities" />
      <StatTile
        label="liabilities"
        :value="fmtCurrency(planning.liabilities.total_balance, ccy)"
        :tone="planning.liabilities.total_balance > 0 ? 'accent' : 'neutral'"
      />
      <StatTile label="monthly surplus" :value="fmtCurrency(planning.cashflow.monthly_surplus, ccy)" :tone="pnlTone(planning.cashflow.monthly_surplus)" />
      <StatTile label="savings rate" :value="savingsRate" />
    </section>

    <div class="grid lg:grid-cols-2 gap-6 [&>*]:min-w-0">
      <section class="surface-1 p-4 sm:p-6 space-y-4">
        <div class="flex items-baseline justify-between gap-3">
          <h2 class="label-eyebrow">allocation vs target</h2>
          <span v-if="planning.data_quality === 'partial'" class="font-mono text-xs text-[var(--accent)]">partial data</span>
        </div>
        <PageState v-if="driftRows.length === 0" kind="empty" message="no target allocation set" />
        <ul v-else class="space-y-4">
          <li v-for="row in driftRows" :key="row.key">
            <div class="flex items-baseline justify-between gap-3 font-mono text-xs">
              <span class="text-[var(--paper-1)]">{{ row.label }}</span>
              <span :class="SEVERITY_CLASS[row.severity]" data-mono>{{ row.drift_pct >= 0 ? '+' : '' }}{{ row.drift_pct.toFixed(1) }} pts</span>
            </div>
            <div class="drift" aria-hidden="true">
              <span class="drift__fill" :class="row.severity === 'ok' ? 'drift__fill--ok' : 'drift__fill--off'" :style="{ width: `${Math.min(100, Math.max(0, row.actual_pct))}%` }" />
              <span class="drift__target" :style="{ left: `${Math.min(100, Math.max(0, row.target_pct))}%` }" />
            </div>
            <div class="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 font-mono text-xs text-[var(--paper-3)]">
              <span>{{ row.actual_pct.toFixed(1) }}% now · {{ row.target_pct.toFixed(1) }}% target</span>
              <span v-if="row.action !== 'hold'" :class="ACTION_CLASS[row.action]" data-mono>{{ actionLabel(row) }}</span>
            </div>
          </li>
        </ul>
      </section>

      <section class="surface-1 p-4 sm:p-6 space-y-4">
        <h2 class="label-eyebrow">goals</h2>
        <PageState v-if="planning.goals.length === 0" kind="empty" message="no goals yet" />
        <ul v-else class="space-y-4">
          <li v-for="goal in planning.goals" :key="goal.key">
            <div class="flex items-baseline justify-between gap-3 font-mono text-xs">
              <span class="text-[var(--paper-1)]">{{ goal.label }}</span>
              <span :class="goal.status === 'behind' ? 'text-[var(--accent)]' : 'text-[var(--paper-3)]'" data-mono>{{ goal.progress_pct.toFixed(0) }}%</span>
            </div>
            <div class="drift" aria-hidden="true">
              <span class="drift__fill" :class="goal.status === 'behind' ? 'drift__fill--off' : 'drift__fill--ok'" :style="{ width: `${Math.min(100, Math.max(0, goal.progress_pct))}%` }" />
            </div>
            <p v-if="goal.note" class="mt-1 font-mono text-xs text-[var(--paper-3)]">{{ goal.note }}</p>
          </li>
        </ul>
      </section>
    </div>

    <section class="surface-1 p-4 sm:p-6 space-y-3">
      <div class="flex flex-wrap items-baseline justify-between gap-3">
        <h2 class="label-eyebrow">monthly snapshots</h2>
        <div class="flex items-center gap-4">
          <button type="button" class="link tap" :disabled="historySaving" @click="emit('capture')">
            {{ historySaving ? 'saving…' : 'save today' }}
          </button>
          <button type="button" class="link tap" @click="emit('edit')">edit plan</button>
        </div>
      </div>
      <PageState v-if="historyError" kind="error" message="snapshots failed to load" />
      <PageState v-else-if="recent.length === 0" kind="empty" message="no snapshots yet; save one to start tracking" />
      <table v-else class="w-full font-mono text-xs">
        <thead>
          <tr class="text-[var(--paper-3)]">
            <th class="text-left font-normal pb-2">date</th>
            <th class="text-right font-normal pb-2">net worth</th>
            <th class="text-right font-normal pb-2">surplus / mo</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="snap in recent" :key="snap.captured_at" class="border-t hairline">
            <td class="py-2 text-[var(--paper-2)]" data-mono>{{ snap.date }}</td>
            <td class="py-2 text-right text-[var(--paper-0)]" data-mono>{{ fmtCurrency(snap.net_worth_adjusted, snap.base_currency) }}</td>
            <td class="py-2 text-right" :class="pnlTone(snap.monthly_surplus) === 'down' ? 'tape-down' : pnlTone(snap.monthly_surplus) === 'up' ? 'tape-up' : 'text-[var(--paper-2)]'" data-mono>
              {{ fmtCurrency(snap.monthly_surplus, snap.base_currency) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="historyMessage" class="font-mono text-xs text-[var(--paper-3)]" role="status">{{ historyMessage }}</p>
    </section>
  </div>
</template>

<style scoped>
.drift {
  position: relative;
  margin-top: 0.4rem;
  height: 6px;
  border-radius: 3px;
  background: var(--ink-3);
}
.drift__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 3px;
}
.drift__fill--ok { background: var(--paper-3); }
.drift__fill--off { background: var(--accent); }
.drift__target {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  margin-left: -1px;
  background: var(--paper-0);
}
.link {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--paper-3);
  white-space: nowrap;
}
.link:hover { color: var(--accent); }
.link:disabled { opacity: 0.5; }
</style>
