<script setup lang="ts">
/* Hallmark · genre: modern-minimal · macrostructure: page header + go-live controls, maturity gate, config form, backtest, signals feed, assistant docked at lg and off-canvas below · design-system: design.md · designed-as-app */

definePageMeta({ section: 'algo' })
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onKeyStroke, useMagicKeys, useMediaQuery, whenever } from '@vueuse/core'
import type {
  AlgoBacktestResult,
  AlgoCadence,
  AlgoSignal,
  AlgoSizingMode,
  AlgoState,
  AlgoStrategy,
} from '../../../server/llm/http'
import { assessAlgoMaturity, type AlgoMaturityStatus } from '../../../server/lib/algo-risk'
import { buildHunks, type DiffPayload } from '../../components/algo/diff-hunks'
import { SIZING_MODES, foldChecks, sizingMeta } from '../../utils/algo-view'

const route = useRoute()
const id = computed(() => route.params.id as string)

useHead({ title: 'algo · edit' })

const { data: strategy, refresh } = await useFetch<AlgoStrategy>(
  () => `/api/algo/strategies/${id.value}`,
)
const { data: state, refresh: refreshState } = await useFetch<AlgoState>('/api/algo/state')
const { data: signals, refresh: refreshSignals } = await useFetch<AlgoSignal[]>(
  () => `/api/algo/signals?strategy_id=${id.value}&limit=20`,
  { default: () => [] },
)

// Poll signals + state every 10s so a fresh tick shows up without reload.
let pollHandle: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  pollHandle = setInterval(() => {
    refreshSignals()
    refreshState()
  }, 10_000)
})
onUnmounted(() => { if (pollHandle) clearInterval(pollHandle) })

if (!strategy.value) {
  throw createError({ statusCode: 404, statusMessage: 'strategy not found' })
}

const draft = ref({
  name: strategy.value.name,
  symbol: strategy.value.symbol,
  cadence: strategy.value.cadence,
  code: strategy.value.code,
  initial_capital: strategy.value.initial_capital,
  commission_bps: strategy.value.commission_bps,
  slippage_bps: strategy.value.slippage_bps,
  sizing_mode: strategy.value.sizing_mode,
  sizing_value: strategy.value.sizing_value,
  pyramiding_max: strategy.value.pyramiding_max,
})

const saveError = ref<string | null>(null)
const saving = ref(false)
const dirty = computed(() => {
  const s = strategy.value!
  return draft.value.name !== s.name
    || draft.value.symbol !== s.symbol
    || draft.value.cadence !== s.cadence
    || draft.value.code !== s.code
    || draft.value.initial_capital !== s.initial_capital
    || draft.value.commission_bps !== s.commission_bps
    || draft.value.slippage_bps !== s.slippage_bps
    || draft.value.sizing_mode !== s.sizing_mode
    || draft.value.sizing_value !== s.sizing_value
    || draft.value.pyramiding_max !== s.pyramiding_max
})

async function save() {
  saveError.value = null
  saving.value = true
  try {
    // Pre-validate the resolved code so the user sees Python syntax /
    // sandbox errors *before* the PUT round-trip. The PUT endpoint
    // re-runs the same validator, but its 422 surfaces less ergonomically
    // and (more importantly) means the partial-accept "broken state"
    // would have been written into network logs / observability before
    // surfacing the real issue.
    const probe = await $fetch<{ ok: boolean; error: string | null }>(
      '/api/algo/validate',
      { method: 'POST', body: { code: draft.value.code } },
    ).catch(() => null)
    if (probe && !probe.ok) {
      saveError.value = probe.error ?? 'invalid code'
      return
    }
    await $fetch(`/api/algo/strategies/${id.value}`, {
      method: 'PUT',
      body: draft.value,
    })
    await refresh()
  } catch (e) {
    saveError.value = formatApiError(e)
  } finally {
    saving.value = false
  }
}

// FastAPI returns `detail` as a string for HTTPException(detail=...) but
// as an array of {loc, msg, type} for Pydantic body-validation 422s. The
// old single-line stringify lost everything in the array case.
function formatApiError(e: unknown): string {
  const detail = (e as { data?: { detail?: unknown } })?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) => {
        const path = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body').join('.') : ''
        return path ? `${path}: ${d.msg}` : (d.msg ?? 'invalid')
      })
      .join('\n')
  }
  return (e as Error)?.message ?? 'request failed'
}

const backtest = ref<AlgoBacktestResult | null>(null)
const backtesting = ref(false)
const bars = ref(200)
const maturity = computed(() => assessAlgoMaturity(draft.value, backtest.value, signals.value ?? []))
const checkFold = computed(() => foldChecks(maturity.value.checks))
const sizing = computed(() => sizingMeta(draft.value.sizing_mode))
const placedOrders = computed(() => (signals.value ?? []).filter(s => s.order_id))

const CADENCES: AlgoCadence[] = ['1m', '5m', '15m', '1h', '1d']
const fieldUi = {
  label: 'label-eyebrow',
  help: 'mt-1 text-xs leading-snug text-[var(--paper-3)]',
}
const canEnableLive = computed(() => strategy.value?.enabled || (!dirty.value && maturity.value.status !== 'block'))

const goLiveBlocker = computed(() => {
  if (strategy.value?.enabled) return null
  if (dirty.value) return 'save your changes and run a fresh backtest first'
  if (maturity.value.status === 'block') return 'run a clean backtest and clear the blocking checks below first'
  return null
})

const toggling = ref(false)
const liveError = ref<string | null>(null)
async function toggleEnabled() {
  liveError.value = null
  if (goLiveBlocker.value) {
    liveError.value = goLiveBlocker.value
    return
  }
  toggling.value = true
  try {
    await $fetch(`/api/algo/strategies/${id.value}`, {
      method: 'PUT',
      body: { enabled: !strategy.value!.enabled },
    })
    await refresh()
    await refreshState()
  } catch (e) {
    liveError.value = `${strategy.value!.enabled ? 'stop' : 'go live'} failed: ${formatApiError(e)}`
  } finally {
    toggling.value = false
  }
}

const killing = ref(false)
const killError = ref<string | null>(null)
async function toggleKill() {
  const path = state.value?.kill_active ? 'unkill' : 'kill'
  killError.value = null
  killing.value = true
  try {
    state.value = await $fetch<AlgoState>(`/api/algo/${path}`, { method: 'POST' })
  } catch (e) {
    killError.value = `kill switch: ${formatApiError(e)}`
  } finally {
    killing.value = false
  }
}

function shortTs(t: string): string {
  return new Date(t).toISOString().slice(5, 16).replace('T', ' ')
}

// --- Editor diff-review handoff -------------------------------------------
//
// Chat blocks emit `review` with a base snapshot + proposed code. We hand
// that to the editor via `activeReview`; the editor's `done` event tells
// us what to commit and how many hunks were accepted. The summary flows
// back to the chat via `finishedReview`, which the assistant watches to
// flip its block status pill.
const activeReview = ref<DiffPayload | null>(null)
const finishedReview = ref<{ blockKey: string, summary: { accepted: number; total: number } } | null>(null)

// Below lg the assistant is an off-canvas panel; at lg+ it docks beside the
// editor. It stays mounted (slid off-screen and inert) rather than living in
// a USlideover, because a slideover unmounts its content on close and the
// assistant's chat history lives in the component.
const isDocked = useMediaQuery('(min-width: 1024px)')
const sidebarOpen = ref(false)
const chatToggleRef = ref<HTMLButtonElement | null>(null)
const sidebarRef = ref<HTMLDivElement | null>(null)
const sidebarInert = computed(() => !isDocked.value && !sidebarOpen.value)

watch(isDocked, (docked) => { if (docked) sidebarOpen.value = false })
watch(sidebarOpen, async (open, wasOpen) => {
  await nextTick()
  if (open) sidebarRef.value?.focus()
  else if (wasOpen) chatToggleRef.value?.focus()
})
onKeyStroke('Escape', () => { if (sidebarOpen.value) sidebarOpen.value = false })

// Ref to the CodeEditor so the global Cmd+S handler can call formatCode()
// regardless of which element currently has focus. CodeMirror's own keymap
// only fires when the editor itself has focus — so without this, pressing
// Cmd+S while focus is on a config input or the chat would still drop
// into the browser's "save page as HTML" dialog.
const editorRef = ref<{ formatCode: () => void } | null>(null)

// VueUse's useMagicKeys gives us a global keystroke listener that calls
// preventDefault on the registered combos before the browser sees them,
// so the "save page as HTML" dialog never appears regardless of focus.
const keys = useMagicKeys({
  passive: false,
  onEventFired(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && e.type === 'keydown') {
      e.preventDefault()
    }
  },
})
// The Proxy from useMagicKeys is typed as possibly-undefined per key, but
// the runtime always returns a ComputedRef. Bang past the type to use it.
whenever(keys['Meta+S']!, () => triggerSave())
whenever(keys['Ctrl+S']!, () => triggerSave())

function triggerSave() {
  editorRef.value?.formatCode()
  if (dirty.value && !saving.value) save()
}

function onReview(blockKey: string, base: string, proposed: string) {
  activeReview.value = {
    blockKey,
    base,
    proposed,
    hunks: buildHunks(base, proposed),
  }
  finishedReview.value = null
}

function onDone(resolved: string, summary: { accepted: number; total: number }) {
  draft.value.code = resolved
  if (activeReview.value) {
    finishedReview.value = { blockKey: activeReview.value.blockKey, summary }
  }
  activeReview.value = null
}

// The chat assistant proposed a backtest-config tweak via the
// `propose_config` tool and the user clicked Apply on the chat card.
// We merge into the draft (so it's dirty + visible), then the user
// hits Save to persist — same model as code edits.
type ProposedConfig = Partial<{
  initial_capital: number
  commission_bps: number
  slippage_bps: number
  sizing_mode: AlgoSizingMode
  sizing_value: number
  pyramiding_max: number
}>

function onApplyConfig(cfg: ProposedConfig) {
  if (cfg.initial_capital !== undefined) draft.value.initial_capital = cfg.initial_capital
  if (cfg.commission_bps !== undefined) draft.value.commission_bps = cfg.commission_bps
  if (cfg.slippage_bps !== undefined) draft.value.slippage_bps = cfg.slippage_bps
  if (cfg.sizing_mode !== undefined) draft.value.sizing_mode = cfg.sizing_mode
  if (cfg.sizing_value !== undefined) draft.value.sizing_value = cfg.sizing_value
  if (cfg.pyramiding_max !== undefined) draft.value.pyramiding_max = cfg.pyramiding_max
}

function maturityClass(status: AlgoMaturityStatus) {
  if (status === 'block') return 'text-[var(--tape-down)]'
  if (status === 'warn') return 'text-[var(--accent)]'
  return 'text-[var(--tape-up)]'
}

async function runBacktest() {
  backtesting.value = true
  backtest.value = null
  try {
    backtest.value = await $fetch<AlgoBacktestResult>(
      `/api/algo/strategies/${id.value}/backtest`,
      { method: 'POST', body: { bars: bars.value } },
    )
  } catch (e) {
    backtest.value = {
      run_id: '',
      status: 'error',
      equity_curve: [],
      benchmark_curve: [],
      price_bars: [],
      trades: [],
      metrics: null,
      error: (e as { data?: { detail?: string } })?.data?.detail
        ?? (e as Error)?.message ?? 'backtest failed',
    }
  } finally {
    backtesting.value = false
  }
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <PageHeader>
      <template #lead>
        <span>algo · edit</span>
      </template>
      <template #actions>
        <span v-if="killError" role="alert" class="text-[var(--tape-down)] normal-case tracking-normal">{{ killError }}</span>
        <button
          v-if="state"
          :disabled="killing"
          class="px-3 py-2 rounded transition-colors disabled:opacity-60"
          :class="state.kill_active
            ? 'bg-[var(--tape-down)] text-[var(--ink-0)]'
            : 'border border-[var(--ink-line-strong)] text-[var(--paper-3)] hover:text-[var(--tape-down)] hover:border-[var(--tape-down)]'"
          @click="toggleKill"
        >{{ killing ? 'switching…' : state.kill_active ? 'kill active · release' : 'kill switch' }}</button>
        <NuxtLink to="/algo" class="gap-1.5 text-[var(--paper-3)] hover:text-[var(--accent)]">
          <UIcon name="i-lucide-arrow-left" class="size-3.5" aria-hidden="true" />strategies
        </NuxtLink>
        <button
          ref="chatToggleRef"
          class="lg:hidden gap-1.5 px-3 py-2 border border-[var(--ink-line-strong)] text-[var(--paper-3)] rounded hover:text-[var(--accent)] hover:border-[var(--accent)]"
          :aria-expanded="sidebarOpen"
          aria-controls="strategy-assistant-sidebar"
          @click="sidebarOpen = !sidebarOpen"
        ><UIcon name="i-lucide-message-square" class="size-3.5" aria-hidden="true" />chat</button>
      </template>
    </PageHeader>

    <div class="flex-1 min-h-0 flex">
      <main class="flex-1 min-w-0 overflow-y-auto scroll-hidden">
        <div class="max-w-5xl mx-auto page-pad space-y-6">
        <div class="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">{{ strategy!.name }}</h1>
            <div class="flex flex-wrap items-center gap-x-2 font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mt-1">
              <span>{{ strategy!.symbol }} · {{ strategy!.cadence }} ·</span>
              <StatusPill :tone="strategy!.enabled ? 'up' : 'neutral'" :label="strategy!.enabled ? 'live (paper)' : 'paused'" />
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <button
              :disabled="toggling || !canEnableLive"
              aria-describedby="go-live-note"
              class="tap font-mono text-xs uppercase tracking-[0.18em] px-4 py-2 rounded transition-colors disabled:opacity-60"
              :class="strategy!.enabled
                ? 'border border-[var(--tape-up)] text-[var(--tape-up)] hover:bg-[var(--tape-up)] hover:text-[var(--ink-0)]'
                : 'border border-[var(--ink-line-strong)] text-[var(--paper-3)] hover:text-[var(--tape-up)] hover:border-[var(--tape-up)]'"
              @click="toggleEnabled"
            >
              {{ toggling ? 'switching…' : strategy!.enabled ? 'stop live' : 'go live (paper)' }}
            </button>
            <UButton
              v-if="dirty"
              color="primary"
              :disabled="saving"
              class="tap font-mono text-xs uppercase tracking-[0.18em] px-4 py-2"
              :label="saving ? 'saving…' : 'save'"
              @click="save"
            />
            <p
              v-if="liveError || goLiveBlocker"
              id="go-live-note"
              :role="liveError ? 'alert' : undefined"
              class="basis-full font-mono text-xs"
              :class="liveError ? 'text-[var(--tape-down)]' : 'text-[var(--paper-3)]'"
            >{{ liveError ?? (goLiveBlocker ? `go live is off: ${goLiveBlocker}` : '') }}</p>
          </div>
        </div>

        <section class="surface-1 p-4 sm:p-5 space-y-4" aria-labelledby="maturity-title">
          <div class="flex flex-col md:flex-row md:items-baseline md:justify-between gap-2">
            <div>
              <h2 id="maturity-title" class="label-eyebrow">paper-live maturity</h2>
              <p class="text-sm text-[var(--paper-2)] mt-1">
                enablement uses the latest backtest in this editor session plus recent signal health
              </p>
            </div>
            <div class="font-mono text-sm uppercase tracking-[0.16em]" :class="maturityClass(maturity.status)" data-mono>
              {{ maturity.status }} · {{ maturity.score }}/100
            </div>
          </div>
          <ul v-if="checkFold.open.length > 0" class="divide-y divide-[var(--ink-line)]">
            <AlgoCheckRow v-for="check in checkFold.open" :key="check.key" :check="check" />
          </ul>
          <details v-if="checkFold.summary" class="group">
            <summary class="tap inline-flex items-center gap-1.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden font-mono text-xs uppercase tracking-[0.14em] text-[var(--tape-up)]">
              <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
              {{ checkFold.summary }}
            </summary>
            <ul class="mt-3 divide-y divide-[var(--ink-line)]">
              <AlgoCheckRow v-for="check in checkFold.passed" :key="check.key" :check="check" />
            </ul>
          </details>
        </section>

        <section class="surface-1 p-4 sm:p-5 space-y-5" aria-label="strategy">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <UFormField label="name" :ui="fieldUi" class="sm:col-span-2">
              <UInput v-model="draft.name" class="w-full" />
            </UFormField>
            <UFormField label="symbol" :ui="fieldUi">
              <UInput v-model="draft.symbol" class="w-full" :ui="{ base: 'font-mono' }" />
            </UFormField>
            <UFormField label="cadence" :ui="fieldUi">
              <USelect v-model="draft.cadence" :items="CADENCES" class="w-full font-mono" />
            </UFormField>
          </div>

          <fieldset class="space-y-3">
            <legend class="label-eyebrow">backtest config</legend>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-5">
              <UFormField label="capital ($)" help="starting cash for backtests only. $10k–$100k is typical." :ui="fieldUi">
                <UInput v-model.number="draft.initial_capital" type="number" min="1" step="1000" class="w-full" :ui="{ base: 'font-mono' }" />
              </UFormField>
              <UFormField label="commission (bps)" help="per trade. 10 bps = 0.10%. US brokers 0–10, HK 10–25." :ui="fieldUi">
                <UInput v-model.number="draft.commission_bps" type="number" min="0" max="1000" class="w-full" :ui="{ base: 'font-mono' }" />
              </UFormField>
              <UFormField label="slippage (bps)" help="fill drift against the signal price. 5 for liquid names, 20–50 for thin ones." :ui="fieldUi">
                <UInput v-model.number="draft.slippage_bps" type="number" min="0" max="1000" class="w-full" :ui="{ base: 'font-mono' }" />
              </UFormField>
              <UFormField label="sizing" help="how a signal becomes a share count." :ui="fieldUi">
                <USelect v-model="draft.sizing_mode" :items="SIZING_MODES" class="w-full font-mono" />
              </UFormField>
              <UFormField :label="sizing.valueLabel" :help="sizing.valueHelp" :ui="fieldUi">
                <UInput v-model.number="draft.sizing_value" type="number" min="0.0001" step="0.5" class="w-full" :ui="{ base: 'font-mono' }" />
              </UFormField>
              <UFormField label="pyramid max" help="buys allowed before going flat. 1 never stacks; extra buys past the cap are dropped." :ui="fieldUi">
                <UInput v-model.number="draft.pyramiding_max" type="number" min="1" max="100" class="w-full" :ui="{ base: 'font-mono' }" />
              </UFormField>
            </div>
          </fieldset>

          <!-- Intentionally a <div>, not a <label>: in diff-review mode the
               textarea is hidden and a bare <label> would forward every click
               to the toolbar's accept-all button. -->
          <div>
            <span class="label-eyebrow">strategy code</span>
            <CodeEditor
              ref="editorRef"
              v-model="draft.code"
              :rows="18"
              :diff="activeReview"
              aria-label="strategy code"
              class="mt-1"
              @done="onDone"
              @save="() => { if (dirty && !saving) save() }"
            />
          </div>

          <div v-if="saveError" role="alert" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
            {{ saveError }}
          </div>
        </section>

        <section class="surface-1 p-4 sm:p-5 space-y-4" aria-labelledby="backtest-title">
          <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h2 id="backtest-title" class="label-eyebrow">backtest</h2>
              <p class="text-sm text-[var(--paper-2)] mt-1">
                daily bars over the last <span class="text-[var(--paper-0)] font-mono">{{ bars }}</span> sessions.
                saved code is what runs.
              </p>
            </div>
            <div class="flex items-end gap-3">
              <UFormField label="bars" :ui="fieldUi">
                <UInput v-model.number="bars" type="number" min="10" max="2000" class="w-24" :ui="{ base: 'font-mono' }" />
              </UFormField>
              <UButton
                color="primary"
                :disabled="backtesting || dirty"
                class="tap font-mono text-xs uppercase tracking-[0.18em] px-4 py-2"
                :label="backtesting ? 'running…' : 'run backtest'"
                @click="runBacktest"
              />
            </div>
          </div>
          <p v-if="dirty" class="font-mono text-xs text-[var(--paper-3)]">
            save your edits before backtesting. the backend reads the saved code.
          </p>

          <AlgoCard
            v-if="backtest"
            :equity="backtest.equity_curve"
            :benchmark="backtest.benchmark_curve"
            :price-bars="backtest.price_bars"
            :trades="backtest.trades"
            :metrics="backtest.metrics"
            :status="backtest.status"
            :error="backtest.error"
          />
        </section>

        <section class="surface-1 p-4 sm:p-5 space-y-4" aria-labelledby="signals-title">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="signals-title" class="label-eyebrow">live signals · last 20</h2>
            <div class="font-mono text-xs text-[var(--paper-3)]">auto-refresh every 10s</div>
          </div>
          <PageState
            v-if="!signals || signals.length === 0"
            kind="empty"
            :message="strategy!.enabled ? 'no signals yet' : 'no signals yet. go live (paper) to start ticking on cadence.'"
          />
          <template v-else>
            <div class="table-scroll max-h-72 overflow-y-auto">
              <table class="w-full font-mono text-xs">
                <thead class="text-[var(--paper-3)] uppercase tracking-wider">
                  <tr>
                    <th class="sticky left-0 bg-[var(--ink-1)] text-left py-1 pr-4">when</th>
                    <th class="text-left py-1">side</th>
                    <th class="text-right py-1">qty</th>
                    <th class="text-right py-1">price</th>
                    <th class="text-left py-1 pl-4">result</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="sig in signals" :key="sig.id" class="border-t border-[var(--ink-line)]">
                    <td class="sticky left-0 bg-[var(--ink-1)] py-1.5 pr-4 text-[var(--paper-2)] whitespace-nowrap">{{ shortTs(sig.ts) }}</td>
                    <td
                      class="py-1.5"
                      :class="sig.side === 'BUY' ? 'text-[var(--tape-up)]' : sig.side === 'SELL' ? 'text-[var(--tape-down)]' : 'text-[var(--paper-3)]'"
                    >{{ sig.side }}</td>
                    <td class="py-1.5 text-right text-[var(--paper-1)]">{{ sig.qty }}</td>
                    <td class="py-1.5 text-right text-[var(--paper-1)]">
                      {{ sig.price !== null ? sig.price.toFixed(2) : '—' }}
                    </td>
                    <td class="py-1.5 pl-4">
                      <span v-if="sig.order_id" class="text-[var(--tape-up)]">order placed</span>
                      <span v-else-if="sig.error" class="block w-64 sm:w-80 whitespace-normal break-words text-[var(--tape-down)]">{{ sig.error }}</span>
                      <span v-else class="text-[var(--paper-3)]">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <details v-if="placedOrders.length > 0" class="group">
              <summary class="tap inline-flex items-center gap-1.5 cursor-pointer list-none [&::-webkit-details-marker]:hidden font-mono text-xs uppercase tracking-[0.14em] text-[var(--paper-3)] hover:text-[var(--paper-1)]">
                <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
                technical details
              </summary>
              <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
                <template v-for="sig in placedOrders" :key="sig.id">
                  <dt class="text-[var(--paper-3)] whitespace-nowrap">{{ shortTs(sig.ts) }} order id</dt>
                  <dd class="text-[var(--paper-2)] break-all">{{ sig.order_id }}</dd>
                </template>
              </dl>
            </details>
          </template>
        </section>
        </div>
      </main>

      <div
        v-if="sidebarOpen"
        class="lg:hidden fixed inset-0 z-40 bg-[color-mix(in_srgb,var(--ink-0)_60%,transparent)]"
        aria-hidden="true"
        @click="sidebarOpen = false"
      />
      <div
        id="strategy-assistant-sidebar"
        ref="sidebarRef"
        tabindex="-1"
        :role="isDocked ? undefined : 'dialog'"
        :aria-modal="isDocked ? undefined : 'true'"
        aria-label="strategy assistant"
        :inert="sidebarInert"
        class="shrink-0 transition-transform duration-200 lg:static lg:translate-x-0 lg:w-[400px] lg:h-auto fixed inset-y-0 right-0 w-[90vw] max-w-[400px] z-50"
        :class="sidebarOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'"
      >
        <StrategyAssistant
          :current-code="draft.code"
          :symbol="draft.symbol"
          :cadence="draft.cadence"
          :active-review-key="activeReview?.blockKey ?? null"
          :finished-review="finishedReview"
          :dismissible="!isDocked"
          @close="sidebarOpen = false"
          @review="onReview"
          @apply="(code) => { draft.code = code }"
          @apply-config="onApplyConfig"
        />
      </div>
    </div>
  </div>
</template>
