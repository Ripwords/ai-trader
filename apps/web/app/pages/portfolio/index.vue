<script setup lang="ts">

definePageMeta({ section: 'portfolio' })
import { computed, ref, watch } from 'vue'
import type { FullPortfolio, FullPortfolioPosition } from '../../../server/lib/holdings'
import type {
  AllocationRow,
  PlanningCashflowKind,
  PlanningSeverity,
  PlanningSettings,
  PlanningSnapshot,
  PlanningSummary,
} from '../../../server/lib/planning'

useHead({ title: 'portfolio' })

// Backend caches /api/portfolio (SWR 60s/10min). The refresh button below
// sets ?force=1 to bypass the cache for an explicit hard-refresh.
const force = ref(0)
const refreshQuery = computed(() => (force.value ? { force: '1', _t: force.value } : {}))
const { data, pending, error, refresh: refreshPortfolio } = useLazyFetch<FullPortfolio>('/api/portfolio', {
  server: true,
  query: refreshQuery,
})
const {
  data: planning,
  pending: planningPending,
  error: planningError,
  refresh: refreshPlanning,
} = useLazyFetch<PlanningSummary>('/api/planning', {
  server: true,
  query: refreshQuery,
})
const {
  data: planningSettings,
  pending: settingsPending,
  error: settingsError,
  refresh: refreshSettings,
} = useLazyFetch<PlanningSettings>('/api/planning/settings', {
  server: true,
})
const {
  data: planningHistory,
  pending: historyPending,
  error: historyError,
  refresh: refreshHistory,
} = useLazyFetch<PlanningSnapshot[]>('/api/planning/history', {
  server: true,
})
const settingsDraft = ref<PlanningSettings | null>(null)
const settingsSaving = ref(false)
const settingsMessage = ref('')
const historySaving = ref(false)
const historyMessage = ref('')
const cashflowKinds: PlanningCashflowKind[] = ['income', 'expense', 'saving']

watch(
  planningSettings,
  (value) => {
    if (!value) return
    settingsDraft.value = JSON.parse(JSON.stringify(value)) as PlanningSettings
  },
  { immediate: true },
)

function hardRefresh() {
  force.value = Date.now()
  refreshPortfolio()
  refreshPlanning()
  refreshSettings()
  refreshHistory()
}

type SortKey = 'allocation_pct' | 'pnl_pct' | 'market_value' | 'symbol'
type SortDir = 'asc' | 'desc'

const sortKey = ref<SortKey>('allocation_pct')
const sortDir = ref<SortDir>('desc')

function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    // Most useful default per column: bigger first for numeric, A→Z for symbol.
    sortDir.value = key === 'symbol' ? 'asc' : 'desc'
  }
}

function sortIndicator(key: SortKey): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? '↑' : '↓'
}

const sortedPositions = computed<FullPortfolioPosition[]>(() => {
  const list = data.value?.positions ?? []
  const dir = sortDir.value === 'asc' ? 1 : -1
  const key = sortKey.value
  return [...list].sort((a, b) => {
    if (key === 'symbol') {
      return a.symbol.localeCompare(b.symbol) * dir
    }
    return ((a[key] ?? 0) - (b[key] ?? 0)) * dir
  })
})

// Top-10 by allocation for the bar chart, regardless of the table sort.
const topAllocations = computed<FullPortfolioPosition[]>(() => {
  const list = data.value?.positions ?? []
  return [...list]
    .sort((a, b) => (b.allocation_pct ?? 0) - (a.allocation_pct ?? 0))
    .slice(0, 10)
})

const allocationDenominator = computed(() => {
  // Scale bars so the largest position fills the row; otherwise small
  // allocations look invisible if the user has hundreds of positions.
  const max = topAllocations.value[0]?.allocation_pct ?? 0
  return max > 0 ? max : 1
})

const planningActions = computed<AllocationRow[]>(() => planning.value?.rebalance_actions.slice(0, 4) ?? [])
const planningRows = computed<AllocationRow[]>(() => planning.value?.allocation_rows.filter(row => row.target_pct > 0 || row.current_value > 0) ?? [])
const targetTotal = computed(() => settingsDraft.value?.target_model.reduce((sum, target) => sum + Number(target.target_pct || 0), 0) ?? 0)
const targetTotalOk = computed(() => Math.abs(targetTotal.value - 100) < 0.01)

// Each allocation bucket gets a fixed swatch colour so the live stacked bar,
// the legend dots, and the drift chart all read as the same thing.
const BUCKET_COLOR: Record<string, string> = {
  cash: 'var(--paper-3)',
  equity: 'var(--accent)',
  bond: 'var(--tape-up)',
}
const bucketColor = (key: string) => BUCKET_COLOR[key] ?? 'var(--paper-2)'

const targetSegments = computed(() =>
  (settingsDraft.value?.target_model ?? []).map(target => ({
    key: target.key,
    pct: Number(target.target_pct || 0),
    color: bucketColor(target.key),
  })),
)

const targetDelta = computed(() => Math.round((targetTotal.value - 100) * 100) / 100)
const targetState = computed(() => {
  if (targetTotalOk.value) return 'balanced'
  const d = targetDelta.value
  const mag = Math.abs(d)
  return `${d > 0 ? 'over' : 'under'} by ${mag.toFixed(mag % 1 === 0 ? 0 : 2)}%`
})

// One-click fix for the most common friction: targets that don't sum to 100.
// Rescales each bucket proportionally; the last bucket absorbs the rounding
// remainder so the total lands on exactly 100. Falls back to an even split
// when every bucket is zero.
function normalizeTargets() {
  const model = settingsDraft.value?.target_model
  if (!model || model.length === 0) return
  const sum = model.reduce((acc, t) => acc + Number(t.target_pct || 0), 0)
  let running = 0
  model.forEach((target, i) => {
    if (i === model.length - 1) {
      target.target_pct = Math.round((100 - running) * 100) / 100
      return
    }
    const next = sum > 0
      ? Math.round((Number(target.target_pct || 0) / sum) * 100 * 100) / 100
      : Math.round((100 / model.length) * 100) / 100
    target.target_pct = next
    running += next
  })
}
const recentPlanningSnapshots = computed<PlanningSnapshot[]>(() => [...(planningHistory.value ?? [])].slice(-5).reverse())

const ghostfolioFailing = computed(() => data.value?.ghostfolio_status === 'failing')
const ghostfolioMissing = computed(() => data.value?.ghostfolio_status === 'not_configured')
const onlyMoomoo = computed(() => ghostfolioFailing.value || ghostfolioMissing.value)

const fmtCurrency = (n: number | null | undefined, ccy: string) => {
  if (n == null || !Number.isFinite(n)) return '—'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: ccy || 'USD',
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${ccy} ${n.toFixed(2)}`
  }
}

const fmtNumber = (n: number | null | undefined, frac = 4) => {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: frac })
}

const fmtPct = (n: number | null | undefined, digits = 2) => {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

const pnlClass = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return ''
  if (n > 0) return 'tape-up'
  if (n < 0) return 'tape-down'
  return ''
}

const severityClass = (severity: PlanningSeverity) => {
  if (severity === 'critical') return 'text-[var(--tape-down)]'
  if (severity === 'alert') return 'text-[var(--accent)]'
  if (severity === 'watch') return 'text-[var(--paper-1)]'
  return 'text-[var(--paper-3)]'
}

const actionClass = (action: AllocationRow['action']) => {
  if (action === 'buy') return 'tape-up'
  if (action === 'sell') return 'tape-down'
  return 'text-[var(--paper-3)]'
}

const actionLabel = (row: AllocationRow) => {
  if (row.action === 'hold') return 'hold'
  return `${row.action} ${fmtCurrency(Math.abs(row.action_value), planning.value?.base_currency ?? baseCcy.value)}`
}

const baseCcy = computed(() => data.value?.net_worth_currency ?? 'MYR')

function addLiability() {
  if (!settingsDraft.value) return
  settingsDraft.value.liabilities.push({
    id: `liability-${Date.now()}`,
    name: 'Liability',
    balance: 0,
    interest_rate_pct: 0,
    minimum_payment: 0,
  })
}

function removeLiability(id: string) {
  if (!settingsDraft.value) return
  settingsDraft.value.liabilities = settingsDraft.value.liabilities.filter(row => row.id !== id)
}

function addCashflowItem(kind: PlanningCashflowKind) {
  if (!settingsDraft.value) return
  settingsDraft.value.cashflow_items.push({
    id: `${kind}-${Date.now()}`,
    name: kind === 'income' ? 'Income' : kind === 'expense' ? 'Expense' : 'Saving',
    kind,
    amount: 0,
  })
}

function removeCashflowItem(id: string) {
  if (!settingsDraft.value) return
  settingsDraft.value.cashflow_items = settingsDraft.value.cashflow_items.filter(row => row.id !== id)
}

async function savePlanningSettings() {
  if (!settingsDraft.value || !targetTotalOk.value) return
  settingsSaving.value = true
  settingsMessage.value = ''
  try {
    const saved = await $fetch<PlanningSettings>('/api/planning/settings', {
      method: 'PUT',
      body: settingsDraft.value,
    })
    planningSettings.value = saved
    settingsDraft.value = JSON.parse(JSON.stringify(saved)) as PlanningSettings
    force.value = Date.now()
    await refreshPlanning()
    settingsMessage.value = 'saved'
  } catch (err) {
    settingsMessage.value = err instanceof Error ? err.message : 'save failed'
  } finally {
    settingsSaving.value = false
  }
}

async function capturePlanningSnapshot() {
  historySaving.value = true
  historyMessage.value = ''
  try {
    const result = await $fetch<{ snapshot: PlanningSnapshot, history: PlanningSnapshot[] }>('/api/planning/history/capture', {
      method: 'POST',
    })
    planningHistory.value = result.history
    historyMessage.value = `captured ${result.snapshot.date}`
  } catch (err) {
    historyMessage.value = err instanceof Error ? err.message : 'capture failed'
  } finally {
    historySaving.value = false
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">portfolio</span>
      </div>
      <div class="flex items-center gap-5">
        <NuxtLink to="/research" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          research
        </NuxtLink>
        <NuxtLink to="/algo" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          algo →
        </NuxtLink>
        <button
          class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]"
          :disabled="pending"
          @click="hardRefresh()"
        >
          {{ pending ? 'refreshing…' : 'refresh' }}
        </button>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-6xl mx-auto px-7 py-8 space-y-8">
        <div v-if="error" class="surface-1 p-6 font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
          failed to load portfolio: {{ error.message }}
        </div>

        <div v-else-if="pending && !data" class="surface-1 p-10 text-center font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
          loading portfolio…
        </div>

        <template v-else-if="data">
          <!-- Ghostfolio status banner -->
          <div
            v-if="ghostfolioFailing"
            class="surface-1 p-4 border-l-2"
            style="border-color: var(--accent)"
          >
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--accent)] mb-1">
              ghostfolio offline
            </div>
            <div class="text-sm text-[var(--paper-2)]">
              Cross-broker aggregate is unavailable — showing Moomoo paper + live positions only. Check the MCP connection.
            </div>
          </div>
          <div
            v-else-if="ghostfolioMissing"
            class="surface-1 p-4 border-l-2"
            style="border-color: var(--paper-3)"
          >
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mb-1">
              ghostfolio not configured
            </div>
            <div class="text-sm text-[var(--paper-2)]">
              Set <span class="font-mono">GHOSTFOLIO_MCP_URL</span> and <span class="font-mono">GHOSTFOLIO_MCP_BEARER</span> to surface cross-broker holdings here.
            </div>
          </div>

          <!-- Top stat cards -->
          <section class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div class="surface-1 p-5">
              <div class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)] mb-2">net worth</div>
              <div class="font-mono text-xl text-[var(--paper-0)]" data-mono>
                {{ fmtCurrency(data.net_worth_total, baseCcy) }}
              </div>
              <div class="font-mono text-[10px] text-[var(--paper-3)] mt-1">{{ baseCcy }} base</div>
            </div>
            <div class="surface-1 p-5">
              <div class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)] mb-2">total cash</div>
              <div class="font-mono text-xl text-[var(--paper-0)]" data-mono>
                {{ fmtCurrency(data.cash_total, baseCcy) }}
              </div>
              <div class="font-mono text-[10px] text-[var(--paper-3)] mt-1">across all accounts</div>
            </div>
            <div class="surface-1 p-5">
              <div class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)] mb-2">positions value</div>
              <div class="font-mono text-xl text-[var(--paper-0)]" data-mono>
                {{ fmtCurrency(data.positions_value, baseCcy) }}
              </div>
              <div class="font-mono text-[10px] text-[var(--paper-3)] mt-1">{{ data.positions.length }} positions</div>
            </div>
            <div class="surface-1 p-5">
              <div class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)] mb-2">total p&amp;l</div>
              <div class="font-mono text-xl" :class="pnlClass(data.total_pnl_pct)" data-mono>
                {{ fmtPct(data.total_pnl_pct) }}
              </div>
              <div class="font-mono text-[10px] text-[var(--paper-3)] mt-1">since cost basis</div>
              </div>
          </section>

          <!-- Planning dashboard -->
          <section class="surface-1 p-6">
            <div class="flex flex-col md:flex-row md:items-baseline md:justify-between gap-2 mb-5">
              <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">planning</div>
              <div class="font-mono text-xs text-[var(--paper-3)]">
                {{ planning?.data_quality === 'partial' ? 'partial data' : 'target allocation' }}
              </div>
            </div>

            <div v-if="planningError" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
              failed to load planning: {{ planningError.message }}
            </div>
            <div v-else-if="planningPending && !planning" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
              loading planning…
            </div>
            <div v-else-if="planning" class="space-y-6">
              <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div class="bg-[var(--ink-2)] border hairline p-3">
                  <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">adjusted net worth</div>
                  <div class="mt-1 font-mono text-lg text-[var(--paper-0)]" data-mono>
                    {{ fmtCurrency(planning.net_worth_adjusted, planning.base_currency) }}
                  </div>
                </div>
                <div class="bg-[var(--ink-2)] border hairline p-3">
                  <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">liabilities</div>
                  <div class="mt-1 font-mono text-lg" :class="planning.liabilities.total_balance > 0 ? 'text-[var(--accent)]' : 'text-[var(--paper-0)]'" data-mono>
                    {{ fmtCurrency(planning.liabilities.total_balance, planning.base_currency) }}
                  </div>
                </div>
                <div class="bg-[var(--ink-2)] border hairline p-3">
                  <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">monthly surplus</div>
                  <div class="mt-1 font-mono text-lg" :class="pnlClass(planning.cashflow.monthly_surplus)" data-mono>
                    {{ fmtCurrency(planning.cashflow.monthly_surplus, planning.base_currency) }}
                  </div>
                </div>
                <div class="bg-[var(--ink-2)] border hairline p-3">
                  <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">savings rate</div>
                  <div class="mt-1 font-mono text-lg text-[var(--paper-0)]" data-mono>
                    {{ planning.cashflow.savings_rate_pct == null ? '—' : `${planning.cashflow.savings_rate_pct.toFixed(1)}%` }}
                  </div>
                </div>
              </div>

              <div class="grid lg:grid-cols-[1.1fr_1fr] gap-8">
                <div class="space-y-6">
                <div>
                  <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--paper-3)] mb-3">allocation drift</div>
                  <div class="space-y-3">
                    <div
                      v-for="row in planningRows"
                      :key="row.key"
                      class="grid grid-cols-[92px_1fr_80px] gap-3 items-center"
                    >
                      <div class="font-mono text-xs text-[var(--paper-1)]">{{ row.label }}</div>
                      <div class="min-w-0">
                        <div class="h-2 bg-[var(--ink-2)] rounded-sm overflow-hidden">
                          <div
                            class="h-full"
                            :style="{
                              width: `${Math.min(100, Math.max(0, row.actual_pct))}%`,
                              background: row.severity === 'ok' ? 'var(--paper-3)' : 'var(--accent)',
                            }"
                          />
                        </div>
                        <div class="mt-1 font-mono text-[10px] text-[var(--paper-3)]">
                          actual {{ row.actual_pct.toFixed(1) }}% · target {{ row.target_pct.toFixed(1) }}%
                        </div>
                      </div>
                      <div class="font-mono text-xs text-right" :class="severityClass(row.severity)" data-mono>
                        {{ row.drift_pct >= 0 ? '+' : '' }}{{ row.drift_pct.toFixed(1) }}pp
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--paper-3)] mb-3">next actions</div>
                  <div v-if="planningActions.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
                    allocation is inside drift bands
                  </div>
                  <div v-else class="space-y-2">
                    <div
                      v-for="row in planningActions"
                      :key="`action-${row.key}`"
                      class="grid grid-cols-[92px_1fr_auto] gap-3 items-center border-b hairline last:border-0 pb-2 last:pb-0"
                    >
                      <div class="font-mono text-xs text-[var(--paper-1)]">{{ row.label }}</div>
                      <div class="font-mono text-[11px] text-[var(--paper-3)]">
                        {{ row.current_value > row.target_value ? 'above target' : 'below target' }}
                      </div>
                      <div class="font-mono text-xs text-right" :class="actionClass(row.action)" data-mono>
                        {{ actionLabel(row) }}
                      </div>
                    </div>
                  </div>
                </div>
                </div>

                <div class="space-y-6">
                  <div>
                  <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--paper-3)] mb-3">goals</div>
                  <div class="space-y-4">
                    <div v-for="goal in planning.goals" :key="goal.key">
                      <div class="flex items-baseline justify-between gap-3">
                        <div class="font-mono text-xs text-[var(--paper-1)]">{{ goal.label }}</div>
                        <div class="font-mono text-xs" :class="goal.status === 'behind' ? 'text-[var(--accent)]' : 'text-[var(--paper-3)]'" data-mono>
                          {{ goal.progress_pct.toFixed(0) }}%
                        </div>
                      </div>
                      <div class="h-2 mt-2 bg-[var(--ink-2)] rounded-sm overflow-hidden">
                        <div
                          class="h-full"
                          :style="{
                            width: `${Math.min(100, Math.max(0, goal.progress_pct))}%`,
                            background: goal.status === 'behind' ? 'var(--accent)' : 'var(--paper-3)',
                          }"
                        />
                      </div>
                      <div class="mt-1 font-mono text-[10px] text-[var(--paper-3)]">
                        {{ goal.note }}
                      </div>
                    </div>
                  </div>
                </div>

                  <div>
                  <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--paper-3)] mb-3">concentration</div>
                  <div v-if="planning.concentration.top_position" class="grid grid-cols-3 gap-3">
                    <div>
                      <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">top</div>
                      <div class="font-mono text-lg text-[var(--paper-0)] mt-1" data-mono>{{ planning.concentration.top_position.symbol }}</div>
                    </div>
                    <div>
                      <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">weight</div>
                      <div class="font-mono text-lg mt-1" :class="severityClass(planning.concentration.top_position.severity)" data-mono>
                        {{ planning.concentration.top_position.allocation_pct.toFixed(1) }}%
                      </div>
                    </div>
                    <div>
                      <div class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)]">over 20%</div>
                      <div class="font-mono text-lg mt-1" :class="planning.concentration.positions_over_20_pct > 0 ? 'text-[var(--tape-down)]' : 'text-[var(--paper-0)]'" data-mono>
                        {{ planning.concentration.positions_over_20_pct }}
                      </div>
                    </div>
                  </div>
                  <div v-else class="font-mono text-xs text-[var(--paper-3)]">
                    no position concentration data
                  </div>
                </div>

                  <div>
                    <div class="flex items-baseline justify-between gap-3 mb-3">
                      <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--paper-3)]">history</div>
                      <button
                        class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)] hover:text-[var(--accent)] disabled:opacity-40 disabled:hover:text-[var(--paper-3)]"
                        :disabled="historySaving"
                        @click="capturePlanningSnapshot()"
                      >
                        {{ historySaving ? 'capturing…' : 'capture' }}
                      </button>
                    </div>
                    <div v-if="historyError" class="font-mono text-xs text-[var(--tape-down)]">
                      history unavailable
                    </div>
                    <div v-else-if="historyPending && recentPlanningSnapshots.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
                      loading history…
                    </div>
                    <div v-else-if="recentPlanningSnapshots.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
                      no snapshots captured
                    </div>
                    <div v-else class="space-y-2">
                      <div
                        v-for="snap in recentPlanningSnapshots"
                        :key="snap.captured_at"
                        class="grid grid-cols-[82px_1fr_1fr] gap-3 items-center border-b hairline last:border-0 pb-2 last:pb-0"
                      >
                        <div class="font-mono text-xs text-[var(--paper-2)]" data-mono>{{ snap.date }}</div>
                        <div class="font-mono text-xs text-[var(--paper-0)] text-right" data-mono>
                          {{ fmtCurrency(snap.net_worth_adjusted, snap.base_currency) }}
                        </div>
                        <div class="font-mono text-xs text-right" :class="pnlClass(snap.monthly_surplus)" data-mono>
                          {{ fmtCurrency(snap.monthly_surplus, snap.base_currency) }}
                        </div>
                      </div>
                    </div>
                    <div v-if="historyMessage" class="mt-2 font-mono text-[10px] text-[var(--paper-3)] truncate">
                      {{ historyMessage }}
                    </div>
                  </div>

              </div>
            </div>
            </div>
          </section>
          <!-- Planning settings — full-width editor (redesigned for clarity) -->
          <section class="surface-1 p-6 space-y-7">
            <div class="flex items-baseline justify-between gap-4">
              <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">planning · settings</div>
              <div
                class="font-mono text-[10px] uppercase tracking-[0.18em]"
                :class="settingsMessage === 'saved'
                  ? 'text-[var(--tape-up)]'
                  : (settingsMessage && settingsMessage !== 'saved') ? 'text-[var(--tape-down)]' : 'text-[var(--paper-3)]'"
              >
                {{ settingsMessage || 'editable model' }}
              </div>
            </div>

            <div v-if="settingsError" class="font-mono text-sm text-[var(--tape-down)]">
              settings unavailable
            </div>
            <div v-else-if="settingsPending && !settingsDraft" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
              loading settings…
            </div>

            <div v-else-if="settingsDraft" class="grid lg:grid-cols-[1.25fr_1fr] gap-x-12 gap-y-9">
              <!-- Target allocation — the hero control -->
              <div class="space-y-4">
                <div class="flex items-baseline justify-between gap-3">
                  <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)]">target allocation</span>
                  <button
                    v-if="!targetTotalOk"
                    class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--accent)] hover:underline underline-offset-4 decoration-[var(--accent)]"
                    @click="normalizeTargets()"
                  >
                    normalize to 100%
                  </button>
                </div>

                <div class="h-3 w-full bg-[var(--ink-2)] rounded-sm overflow-hidden flex">
                  <div
                    v-for="seg in targetSegments"
                    :key="`seg-${seg.key}`"
                    class="h-full transition-[width] duration-300 ease-out"
                    :style="{
                      width: `${targetTotal > 0 ? (seg.pct / targetTotal) * 100 : 0}%`,
                      background: seg.color,
                    }"
                  />
                </div>

                <div>
                  <label
                    v-for="target in settingsDraft.target_model"
                    :key="target.key"
                    class="grid grid-cols-[12px_1fr_116px] items-center gap-3 py-2.5 border-b hairline last:border-0"
                  >
                    <span class="w-2.5 h-2.5 rounded-full" :style="{ background: bucketColor(target.key) }" />
                    <span class="font-mono text-sm text-[var(--paper-1)]">{{ target.label }}</span>
                    <span class="relative">
                      <input
                        v-model.number="target.target_pct"
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        class="w-full bg-[var(--ink-2)] border hairline pl-3 pr-7 py-2.5 font-mono text-sm text-right text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                        data-mono
                      >
                      <span class="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-xs text-[var(--paper-3)] pointer-events-none">%</span>
                    </span>
                  </label>
                </div>

                <div class="flex items-center justify-between border-t hairline pt-3">
                  <span class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--paper-3)]">total</span>
                  <div class="flex items-baseline gap-2.5">
                    <span
                      class="font-mono text-lg tabular-nums"
                      :class="targetTotalOk ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'"
                      data-mono
                    >
                      {{ targetTotal.toFixed(targetTotal % 1 === 0 ? 0 : 1) }}%
                    </span>
                    <span
                      class="font-mono text-[10px] uppercase tracking-[0.14em]"
                      :class="targetTotalOk ? 'text-[var(--paper-3)]' : 'text-[var(--tape-down)]'"
                    >
                      {{ targetState }}
                    </span>
                  </div>
                </div>
              </div>

              <!-- Reserve & contributions -->
              <div class="space-y-4">
                <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)]">reserve &amp; contributions</span>
                <label class="block">
                  <span class="block font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)] mb-1.5">monthly expenses</span>
                  <input
                    v-model.number="settingsDraft.monthly_expenses"
                    type="number"
                    min="0"
                    step="100"
                    class="w-full bg-[var(--ink-2)] border hairline px-3 py-2.5 font-mono text-sm text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                    data-mono
                  >
                </label>
                <div class="grid grid-cols-2 gap-3">
                  <label class="block">
                    <span class="block font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)] mb-1.5">emergency · months</span>
                    <input
                      v-model.number="settingsDraft.emergency_fund_months"
                      type="number"
                      min="0"
                      max="36"
                      step="1"
                      class="w-full bg-[var(--ink-2)] border hairline px-3 py-2.5 font-mono text-sm text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                      data-mono
                    >
                  </label>
                  <label class="block">
                    <span class="block font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)] mb-1.5">monthly contribution</span>
                    <input
                      v-model.number="settingsDraft.monthly_contribution"
                      type="number"
                      min="0"
                      step="100"
                      class="w-full bg-[var(--ink-2)] border hairline px-3 py-2.5 font-mono text-sm text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                      data-mono
                    >
                  </label>
                </div>
                <p class="font-mono text-[10px] leading-relaxed text-[var(--paper-3)]">
                  Drives the cash-reserve goal and contribution projection. Add explicit cashflow lines below to override these monthly assumptions.
                </p>
              </div>

              <!-- Liabilities -->
              <div class="lg:col-span-2 border-t hairline pt-7 space-y-3">
                <div class="flex items-baseline justify-between gap-3">
                  <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)]">liabilities</span>
                  <button
                    class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)] hover:text-[var(--accent)] hover:border-[var(--accent)] border hairline px-2.5 py-1 transition-colors"
                    @click="addLiability()"
                  >
                    + add
                  </button>
                </div>
                <div v-if="settingsDraft.liabilities.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
                  no liabilities tracked
                </div>
                <div v-else class="space-y-2">
                  <div
                    v-for="liability in settingsDraft.liabilities"
                    :key="liability.id"
                    class="grid grid-cols-2 md:grid-cols-[1fr_120px_92px_120px_auto] gap-2.5 items-end"
                  >
                    <label class="block">
                      <span class="block font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">name</span>
                      <input
                        v-model="liability.name"
                        type="text"
                        class="w-full bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                      >
                    </label>
                    <label class="block">
                      <span class="block font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">balance</span>
                      <input
                        v-model.number="liability.balance"
                        type="number"
                        min="0"
                        step="100"
                        class="w-full bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                        data-mono
                      >
                    </label>
                    <label class="block">
                      <span class="block font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">rate %</span>
                      <input
                        v-model.number="liability.interest_rate_pct"
                        type="number"
                        min="0"
                        max="100"
                        step="0.1"
                        class="w-full bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                        data-mono
                      >
                    </label>
                    <label class="block">
                      <span class="block font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">min pay</span>
                      <input
                        v-model.number="liability.minimum_payment"
                        type="number"
                        min="0"
                        step="50"
                        class="w-full bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                        data-mono
                      >
                    </label>
                    <button
                      class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--paper-3)] hover:text-[var(--tape-down)] md:pb-2.5 transition-colors"
                      @click="removeLiability(liability.id)"
                    >
                      remove
                    </button>
                  </div>
                </div>
              </div>

              <!-- Cashflow -->
              <div class="lg:col-span-2 border-t hairline pt-7 space-y-3">
                <div class="flex flex-col md:flex-row md:items-baseline md:justify-between gap-3">
                  <span class="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--paper-3)]">cashflow lines</span>
                  <div class="flex items-center gap-2">
                    <button
                      v-for="kind in cashflowKinds"
                      :key="kind"
                      class="font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--paper-3)] hover:text-[var(--accent)] hover:border-[var(--accent)] border hairline px-2.5 py-1 transition-colors"
                      @click="addCashflowItem(kind)"
                    >
                      + {{ kind }}
                    </button>
                  </div>
                </div>
                <div v-if="settingsDraft.cashflow_items.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
                  using the monthly assumptions above
                </div>
                <div v-else class="space-y-2">
                  <div
                    v-for="item in settingsDraft.cashflow_items"
                    :key="item.id"
                    class="grid grid-cols-2 md:grid-cols-[110px_1fr_130px_auto] gap-2.5 items-end"
                  >
                    <label class="block">
                      <span class="block font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">kind</span>
                      <select
                        v-model="item.kind"
                        class="w-full bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                      >
                        <option value="income">income</option>
                        <option value="expense">expense</option>
                        <option value="saving">saving</option>
                      </select>
                    </label>
                    <label class="block">
                      <span class="block font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">name</span>
                      <input
                        v-model="item.name"
                        type="text"
                        class="w-full bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                      >
                    </label>
                    <label class="block">
                      <span class="block font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--paper-3)] mb-1">amount / mo</span>
                      <input
                        v-model.number="item.amount"
                        type="number"
                        min="0"
                        step="100"
                        class="w-full bg-[var(--ink-2)] border hairline px-3 py-2 font-mono text-xs text-[var(--paper-0)] outline-none focus:border-[var(--accent)] transition-colors"
                        data-mono
                      >
                    </label>
                    <button
                      class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--paper-3)] hover:text-[var(--tape-down)] md:pb-2.5 transition-colors"
                      @click="removeCashflowItem(item.id)"
                    >
                      remove
                    </button>
                  </div>
                </div>
              </div>

              <!-- Save -->
              <div class="lg:col-span-2 border-t hairline pt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <span class="font-mono text-[11px] text-[var(--paper-3)]">
                  {{ settingsSaving
                    ? 'saving…'
                    : targetTotalOk
                      ? 'changes are ready to save'
                      : 'balance targets to 100% to enable save' }}
                </span>
                <button
                  class="font-mono text-xs uppercase tracking-[0.18em] px-6 py-2.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  :class="(!settingsSaving && targetTotalOk)
                    ? 'border-[var(--accent)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--ink-0)]'
                    : 'hairline text-[var(--paper-3)]'"
                  :disabled="settingsSaving || !targetTotalOk"
                  @click="savePlanningSettings()"
                >
                  {{ settingsSaving ? 'saving…' : 'save settings' }}
                </button>
              </div>
            </div>
          </section>


          <!-- Account breakdown (Ghostfolio aggregate) -->
          <section v-if="data.accounts.length > 0" class="surface-1 p-6">
            <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)] mb-4">accounts</div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] border-b hairline">
                    <th class="py-2 pr-4">name</th>
                    <th class="py-2 pr-4">platform</th>
                    <th class="py-2 pr-4">currency</th>
                    <th class="py-2 pr-4 text-right">balance</th>
                    <th class="py-2 text-right">value (base)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="acc in data.accounts"
                    :key="acc.name"
                    class="border-b hairline last:border-0"
                  >
                    <td class="py-2 pr-4 text-[var(--paper-1)]">{{ acc.name }}</td>
                    <td class="py-2 pr-4 text-[var(--paper-2)]">{{ acc.platform ?? '—' }}</td>
                    <td class="py-2 pr-4 font-mono text-[var(--paper-2)]" data-mono>{{ acc.currency }}</td>
                    <td class="py-2 pr-4 text-right font-mono text-[var(--paper-1)]" data-mono>
                      {{ fmtCurrency(acc.balance, acc.currency) }}
                    </td>
                    <td class="py-2 text-right font-mono text-[var(--paper-0)]" data-mono>
                      {{ fmtCurrency(acc.value_in_base, baseCcy) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Allocation bars (top 10) -->
          <section v-if="topAllocations.length > 0" class="surface-1 p-6">
            <div class="flex items-baseline justify-between mb-4">
              <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">top allocations</div>
              <div class="font-mono text-xs text-[var(--paper-3)]">top {{ topAllocations.length }} of {{ data.positions.length }}</div>
            </div>
            <div class="space-y-2">
              <div
                v-for="p in topAllocations"
                :key="`alloc-${p.symbol}`"
                class="grid grid-cols-[120px_1fr_80px_70px] gap-3 items-center"
              >
                <div class="font-mono text-sm text-[var(--paper-1)] truncate" data-mono>{{ p.symbol }}</div>
                <div class="h-2 bg-[var(--ink-2)] rounded-sm overflow-hidden">
                  <div
                    class="h-full"
                    :style="{
                      width: `${Math.min(100, (p.allocation_pct / allocationDenominator) * 100)}%`,
                      background: 'var(--accent)',
                    }"
                  />
                </div>
                <div class="font-mono text-xs text-[var(--paper-2)] text-right" data-mono>
                  {{ p.allocation_pct.toFixed(1) }}%
                </div>
                <div class="font-mono text-xs text-right" :class="pnlClass(p.pnl_pct)" data-mono>
                  {{ fmtPct(p.pnl_pct, 1) }}
                </div>
              </div>
            </div>
          </section>

          <!-- Positions table -->
          <section v-if="data.positions.length > 0" class="surface-1 p-6">
            <div class="flex items-baseline justify-between mb-4">
              <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">positions (ghostfolio aggregate)</div>
              <div class="font-mono text-xs text-[var(--paper-3)]">click headers to sort</div>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] border-b hairline">
                    <th class="py-2 pr-4 cursor-pointer hover:text-[var(--accent)]" @click="setSort('symbol')">
                      symbol {{ sortIndicator('symbol') }}
                    </th>
                    <th class="py-2 pr-4">name</th>
                    <th class="py-2 pr-4 text-right">qty</th>
                    <th class="py-2 pr-4 text-right cursor-pointer hover:text-[var(--accent)]" @click="setSort('market_value')">
                      value {{ sortIndicator('market_value') }}
                    </th>
                    <th class="py-2 pr-4 text-right cursor-pointer hover:text-[var(--accent)]" @click="setSort('allocation_pct')">
                      alloc {{ sortIndicator('allocation_pct') }}
                    </th>
                    <th class="py-2 text-right cursor-pointer hover:text-[var(--accent)]" @click="setSort('pnl_pct')">
                      p&amp;l {{ sortIndicator('pnl_pct') }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="p in sortedPositions"
                    :key="p.symbol"
                    class="border-b hairline last:border-0"
                  >
                    <td class="py-2 pr-4 font-mono text-[var(--paper-0)]" data-mono>{{ p.symbol }}</td>
                    <td class="py-2 pr-4 text-[var(--paper-2)] truncate max-w-[240px]">{{ p.name }}</td>
                    <td class="py-2 pr-4 text-right font-mono text-[var(--paper-2)]" data-mono>{{ fmtNumber(p.quantity) }}</td>
                    <td class="py-2 pr-4 text-right font-mono text-[var(--paper-1)]" data-mono>
                      {{ fmtCurrency(p.market_value, baseCcy) }}
                    </td>
                    <td class="py-2 pr-4 text-right font-mono text-[var(--paper-2)]" data-mono>
                      {{ p.allocation_pct.toFixed(2) }}%
                    </td>
                    <td class="py-2 text-right font-mono" :class="pnlClass(p.pnl_pct)" data-mono>
                      {{ fmtPct(p.pnl_pct) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Moomoo paper + live (broken out) -->
          <section v-if="data.moomoo_paper.length > 0 || data.moomoo_live.length > 0" class="grid md:grid-cols-2 gap-4">
            <div class="surface-1 p-6">
              <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)] mb-4">
                moomoo · paper <span class="text-[var(--paper-3)] normal-case">({{ data.moomoo_paper.length }})</span>
              </div>
              <div v-if="data.moomoo_paper.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
                no paper positions
              </div>
              <table v-else class="w-full text-sm">
                <thead>
                  <tr class="text-left font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] border-b hairline">
                    <th class="py-2 pr-4">symbol</th>
                    <th class="py-2 pr-4 text-right">qty</th>
                    <th class="py-2 pr-4 text-right">value</th>
                    <th class="py-2 text-right">p&amp;l</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(p, i) in data.moomoo_paper"
                    :key="`paper-${p.symbol}-${i}`"
                    class="border-b hairline last:border-0"
                  >
                    <td class="py-2 pr-4 font-mono text-[var(--paper-0)]" data-mono>{{ p.symbol }}</td>
                    <td class="py-2 pr-4 text-right font-mono text-[var(--paper-2)]" data-mono>{{ fmtNumber(p.quantity) }}</td>
                    <td class="py-2 pr-4 text-right font-mono text-[var(--paper-1)]" data-mono>{{ fmtNumber(p.market_value, 2) }}</td>
                    <td class="py-2 text-right font-mono" :class="pnlClass(p.pnl_pct)" data-mono>{{ fmtPct(p.pnl_pct) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="surface-1 p-6">
              <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)] mb-4">
                moomoo · live <span class="text-[var(--paper-3)] normal-case">({{ data.moomoo_live.length }})</span>
              </div>
              <div v-if="data.moomoo_live.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
                no live positions
              </div>
              <table v-else class="w-full text-sm">
                <thead>
                  <tr class="text-left font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] border-b hairline">
                    <th class="py-2 pr-4">symbol</th>
                    <th class="py-2 pr-4 text-right">qty</th>
                    <th class="py-2 pr-4 text-right">value</th>
                    <th class="py-2 text-right">p&amp;l</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(p, i) in data.moomoo_live"
                    :key="`live-${p.symbol}-${i}`"
                    class="border-b hairline last:border-0"
                  >
                    <td class="py-2 pr-4 font-mono text-[var(--paper-0)]" data-mono>{{ p.symbol }}</td>
                    <td class="py-2 pr-4 text-right font-mono text-[var(--paper-2)]" data-mono>{{ fmtNumber(p.quantity) }}</td>
                    <td class="py-2 pr-4 text-right font-mono text-[var(--paper-1)]" data-mono>{{ fmtNumber(p.market_value, 2) }}</td>
                    <td class="py-2 text-right font-mono" :class="pnlClass(p.pnl_pct)" data-mono>{{ fmtPct(p.pnl_pct) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Empty state when both Ghostfolio and Moomoo have nothing -->
          <div
            v-if="onlyMoomoo && data.moomoo_paper.length === 0 && data.moomoo_live.length === 0"
            class="font-mono text-sm text-[var(--paper-3)] text-center py-16"
          >
            no positions found in any connected account.
          </div>
        </template>
      </div>
    </main>
  </div>
</template>
