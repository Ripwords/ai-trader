<script setup lang="ts">
/* Hallmark · genre: modern-minimal · macrostructure: header / key figures / tabbed workspace / slideover editor · design-system: design.md · designed-as-app */

definePageMeta({ section: 'portfolio' })
import { computed, onMounted, ref } from 'vue'
import type { FullPortfolio } from '../../../server/lib/holdings'
import type { PortfolioCorrelationResult } from '../../../server/lib/portfolio-correlation-core'
import type { PlanningSettings, PlanningSnapshot, PlanningSummary } from '../../../server/lib/planning'
import type { CaptureResult, PortfolioPerformance } from '../../../server/lib/portfolio-history'
import { captureDailySnapshot } from '../../../composables/useDailySnapshotCapture'
import { apiErrorMessage } from '~/lib/api-error'
import { PORTFOLIO_TABS, attentionItems, keyFigures, parseTab, type PortfolioTab } from '~/utils/portfolio-view'

useHead({ title: 'portfolio' })

const route = useRoute()
const router = useRouter()
const tab = computed<PortfolioTab>({
  get: () => parseTab(route.query.tab),
  set: (value) => {
    void router.replace({ query: { ...route.query, tab: value === 'overview' ? undefined : value } })
  },
})
const tabItems = PORTFOLIO_TABS.map(t => ({ label: t.label, value: t.value }))

// /api/portfolio is cached server-side (SWR); refresh sets ?force=1 to bypass it.
const force = ref(0)
const refreshQuery = computed(() => (force.value ? { force: '1', _t: force.value } : {}))
const { data, pending, error, refresh: refreshPortfolio } = useLazyFetch<FullPortfolio>('/api/portfolio', {
  server: true,
  query: refreshQuery,
})
const {
  data: correlation,
  pending: correlationPending,
  error: correlationError,
  refresh: refreshCorrelation,
} = useLazyFetch<PortfolioCorrelationResult>('/api/portfolio/correlation', { server: true, query: refreshQuery })
const {
  data: planning,
  pending: planningPending,
  error: planningError,
  refresh: refreshPlanning,
} = useLazyFetch<PlanningSummary>('/api/planning', { server: true, query: refreshQuery })
const { data: planningSettings, refresh: refreshSettings } = useLazyFetch<PlanningSettings>('/api/planning/settings', { server: true })
const { data: planningHistory, error: historyError, refresh: refreshHistory } = useLazyFetch<PlanningSnapshot[]>('/api/planning/history', { server: true })
const {
  data: performance,
  pending: performancePending,
  error: performanceError,
  refresh: refreshPerformance,
} = useLazyFetch<PortfolioPerformance>('/api/portfolio/performance', { server: true })

const figures = computed(() => (data.value ? keyFigures(data.value, performance.value ?? null) : []))
const attention = computed(() => (planning.value ? attentionItems(planning.value) : []))
const ghostfolioStatus = computed(() => data.value?.ghostfolio_status)
const nothingHeld = computed(() => {
  const p = data.value
  return !!p && p.positions.length === 0 && p.moomoo_live.length === 0 && p.moomoo_paper.length === 0
})

function hardRefresh() {
  force.value = Date.now()
  void refreshPortfolio()
  void refreshCorrelation()
  void refreshPlanning()
  void refreshSettings()
  void refreshHistory()
  void refreshPerformance()
}

const snapshotSaving = ref(false)
const snapshotMessage = ref('')
async function captureSnapshot() {
  snapshotSaving.value = true
  snapshotMessage.value = ''
  try {
    const result = await $fetch<CaptureResult>('/api/portfolio/capture-snapshot', { method: 'POST' })
    snapshotMessage.value = result.capturedAt ? `saved ${result.capturedAt.slice(0, 16).replace('T', ' ')}` : 'saved'
    await refreshPerformance()
  } catch (err) {
    snapshotMessage.value = apiErrorMessage(err, 'snapshot failed')
  } finally {
    snapshotSaving.value = false
  }
}
onMounted(() => {
  void captureDailySnapshot({
    post: (url, body) => $fetch<CaptureResult>(url, { method: 'POST', body }),
    refresh: refreshPerformance,
  })
})

const historySaving = ref(false)
const historyMessage = ref('')
async function capturePlanningSnapshot() {
  historySaving.value = true
  historyMessage.value = ''
  try {
    const result = await $fetch<{ snapshot: PlanningSnapshot, history: PlanningSnapshot[] }>('/api/planning/history/capture', { method: 'POST' })
    planningHistory.value = result.history
    historyMessage.value = `saved ${result.snapshot.date}`
  } catch (err) {
    historyMessage.value = apiErrorMessage(err, 'snapshot failed')
  } finally {
    historySaving.value = false
  }
}

const editorOpen = ref(false)
const settingsSaving = ref(false)
const settingsError = ref('')
function openEditor() {
  settingsError.value = ''
  editorOpen.value = true
}
async function savePlanningSettings(draft: PlanningSettings) {
  settingsSaving.value = true
  settingsError.value = ''
  try {
    planningSettings.value = await $fetch<PlanningSettings>('/api/planning/settings', { method: 'PUT', body: draft })
    force.value = Date.now()
    await refreshPlanning()
    editorOpen.value = false
  } catch (err) {
    settingsError.value = apiErrorMessage(err, 'save failed')
  } finally {
    settingsSaving.value = false
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <PageHeader>
      <template #lead>
        <span>portfolio</span>
      </template>
      <template #actions>
        <button type="button" class="text-[var(--paper-3)] hover:text-[var(--accent)]" :disabled="!planningSettings" @click="openEditor()">
          edit plan
        </button>
        <button type="button" class="text-[var(--paper-3)] hover:text-[var(--accent)]" :disabled="pending" @click="hardRefresh()">
          {{ pending ? 'refreshing…' : 'refresh' }}
        </button>
      </template>
    </PageHeader>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-6xl mx-auto page-pad space-y-6">
        <PageState v-if="error && !data" kind="error" :message="`portfolio failed to load: ${error.message}`" @retry="hardRefresh()" />
        <PageState v-else-if="!data" kind="loading" message="loading portfolio…" />

        <template v-else>
          <p v-if="ghostfolioStatus === 'failing'" class="notice" role="status">
            The all-accounts view is offline, so only moomoo positions are shown. Check the Ghostfolio connection in settings.
          </p>
          <p v-else-if="ghostfolioStatus === 'not_configured'" class="notice" role="status">
            Only moomoo positions are shown. Connect Ghostfolio to see every account in one place.
          </p>

          <section class="surface-1 p-4 sm:p-6 grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-5" aria-label="key figures">
            <StatTile
              v-for="(f, i) in figures"
              :key="f.label"
              :label="f.label"
              :value="f.value"
              :sub="f.sub"
              :tone="f.tone"
              :size="i === 0 ? 'lg' : 'md'"
              :class="i === 0 ? 'col-span-2 lg:col-span-1' : undefined"
            />
          </section>

          <UTabs v-model="tab" :items="tabItems" :content="false" variant="link" class="portfolio-tabs" />

          <div v-if="tab === 'overview'" class="space-y-6">
            <section class="surface-1 p-4 sm:p-6 space-y-3">
              <div class="flex items-baseline justify-between gap-3">
                <h2 class="label-eyebrow">needs attention</h2>
                <button v-if="attention.length > 0" type="button" class="tab-link tap" @click="tab = 'plan'">open plan</button>
              </div>
              <PageState v-if="planningError" kind="error" message="plan failed to load" @retry="refreshPlanning()" />
              <PageState v-else-if="!planning && planningPending" kind="loading" message="checking your plan…" />
              <p v-else-if="attention.length === 0" class="font-mono text-xs text-[var(--paper-3)]">nothing. allocation, concentration and goals are on track.</p>
              <ul v-else>
                <li v-for="item in attention" :key="item.key" class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 border-b hairline last:border-0">
                  <span class="text-sm text-[var(--paper-0)]">{{ item.label }}</span>
                  <span class="font-mono text-xs" :class="item.tone === 'down' ? 'text-[var(--tape-down)]' : 'text-[var(--accent)]'">{{ item.detail }}</span>
                </li>
              </ul>
            </section>

            <PortfolioPerformanceCard
              :series="performance?.series ?? []"
              :stats="performance?.stats ?? null"
              :pending="performancePending"
              :capturing="snapshotSaving"
              :error-message="performanceError?.message ?? ''"
              :message="snapshotMessage"
              @capture="captureSnapshot()"
            />
          </div>

          <div v-else-if="tab === 'holdings'" class="space-y-6">
            <PageState v-if="nothingHeld" kind="empty" message="no positions in any connected account" />
            <PortfolioHoldings v-else :portfolio="data" />
            <AlertsPanel />
          </div>

          <div v-else-if="tab === 'plan'">
            <PageState v-if="planningError" kind="error" :message="`plan failed to load: ${planningError.message}`" @retry="refreshPlanning()" />
            <PageState v-else-if="!planning" kind="loading" message="loading plan…" />
            <PortfolioPlan
              v-else
              :planning="planning"
              :history="planningHistory ?? []"
              :history-error="!!historyError"
              :history-saving="historySaving"
              :history-message="historyMessage"
              @capture="capturePlanningSnapshot()"
              @edit="openEditor()"
            />
          </div>

          <div v-else class="space-y-6">
            <section v-if="planning?.concentration.top_position" class="surface-1 p-4 sm:p-6 grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-5" aria-label="concentration">
              <StatTile label="largest position" :value="planning.concentration.top_position.symbol" />
              <StatTile
                label="its weight"
                :value="`${planning.concentration.top_position.allocation_pct.toFixed(1)}%`"
                :tone="planning.concentration.top_position.severity === 'ok' ? 'neutral' : planning.concentration.top_position.severity === 'critical' ? 'down' : 'accent'"
              />
              <StatTile
                label="positions over 20%"
                :value="String(planning.concentration.positions_over_20_pct)"
                :sub="`${planning.concentration.positions_over_10_pct} over 10%`"
                :tone="planning.concentration.positions_over_20_pct > 0 ? 'down' : 'neutral'"
              />
            </section>
            <PortfolioCorrelationMatrix
              :correlation="correlation ?? null"
              :pending="correlationPending"
              :error-message="correlationError?.message ?? ''"
            />
          </div>
        </template>
      </div>
    </main>

    <PortfolioPlanEditor
      v-model:open="editorOpen"
      :settings="planningSettings ?? null"
      :saving="settingsSaving"
      :error="settingsError"
      @save="savePlanningSettings"
    />
  </div>
</template>

<style scoped>
.notice {
  padding: 0.75rem 1rem;
  border: 1px solid var(--ink-line-strong);
  border-radius: var(--radius-card);
  font-size: 0.875rem;
  color: var(--paper-2);
}
.tab-link {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.tab-link:hover { color: var(--accent); }
</style>
