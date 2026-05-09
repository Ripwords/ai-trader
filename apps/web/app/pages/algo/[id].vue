<script setup lang="ts">

definePageMeta({ section: 'algo' })
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useMagicKeys, whenever } from '@vueuse/core'
import type {
  AlgoBacktestResult,
  AlgoSignal,
  AlgoState,
  AlgoStrategy,
} from '../../../server/llm/http'
import { buildHunks, type DiffPayload } from '../../components/algo/diff-hunks'

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
  return (e as Error)?.message ?? 'save failed'
}

const backtest = ref<AlgoBacktestResult | null>(null)
const backtesting = ref(false)
const bars = ref(200)

const toggling = ref(false)
async function toggleEnabled() {
  toggling.value = true
  try {
    await $fetch(`/api/algo/strategies/${id.value}`, {
      method: 'PUT',
      body: { enabled: !strategy.value!.enabled },
    })
    await refresh()
    await refreshState()
  } finally {
    toggling.value = false
  }
}

async function toggleKill() {
  const path = state.value?.kill_active ? 'unkill' : 'kill'
  state.value = await $fetch<AlgoState>(`/api/algo/${path}`, { method: 'POST' })
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

// Mobile-only: the chat sidebar is off-canvas by default at narrow widths
// and revealed via a header toggle. On md+ it stays in the flex layout
// permanently and `sidebarOpen` is irrelevant.
const sidebarOpen = ref(false)

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
  sizing_mode: 'fixed_qty' | 'pct_equity' | 'fixed_cash'
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
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">algo · edit</span>
      </div>
      <div class="flex items-center gap-5">
        <button
          v-if="state"
          class="font-mono text-xs uppercase tracking-[0.18em] px-3 py-2 rounded transition-colors"
          :class="state.kill_active
            ? 'bg-[var(--tape-down)] text-[#07080a]'
            : 'border border-[rgba(255,245,230,0.12)] text-[var(--paper-3)] hover:text-[var(--tape-down)] hover:border-[var(--tape-down)]'"
          @click="toggleKill"
        >{{ state.kill_active ? '◼ kill active — click to release' : '◯ kill switch' }}</button>
        <NuxtLink to="/algo" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          ← strategies
        </NuxtLink>
        <button
          class="md:hidden font-mono text-xs uppercase tracking-[0.18em] px-3 py-2 border border-[rgba(255,245,230,0.12)] text-[var(--paper-3)] rounded hover:text-[var(--accent)] hover:border-[var(--accent)]"
          @click="sidebarOpen = !sidebarOpen"
          :aria-expanded="sidebarOpen"
          aria-controls="strategy-assistant-sidebar"
        >{{ sidebarOpen ? '✕ chat' : '💬 chat' }}</button>
      </div>
    </header>

    <div class="flex-1 min-h-0 flex">
      <main class="flex-1 min-w-0 overflow-y-auto scroll-hidden">
        <div class="max-w-5xl mx-auto px-7 py-8 space-y-6">
        <!-- Header card -->
        <div class="flex items-baseline justify-between">
          <div>
            <h1 class="text-2xl font-semibold tracking-tight">{{ strategy!.name }}</h1>
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mt-1">
              {{ strategy!.symbol }} · {{ strategy!.cadence }} ·
              <span :class="strategy!.enabled ? 'text-[var(--tape-up)]' : 'text-[var(--paper-3)]'">
                {{ strategy!.enabled ? '● live (paper)' : '○ paused' }}
              </span>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <button
              :disabled="toggling"
              class="font-mono text-xs uppercase tracking-[0.18em] px-4 py-2 rounded transition-colors disabled:opacity-60"
              :class="strategy!.enabled
                ? 'border border-[var(--tape-up)] text-[var(--tape-up)] hover:bg-[var(--tape-up)] hover:text-[#07080a]'
                : 'border border-[rgba(255,245,230,0.12)] text-[var(--paper-3)] hover:text-[var(--tape-up)] hover:border-[var(--tape-up)]'"
              @click="toggleEnabled"
            >
              {{ toggling ? 'switching…' : strategy!.enabled ? '◼ stop live' : '▶ go live (paper)' }}
            </button>
            <button
              v-if="dirty"
              :disabled="saving"
              class="font-mono text-xs uppercase tracking-[0.18em] px-4 py-2 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f] disabled:opacity-60"
              @click="save"
            >
              {{ saving ? 'saving…' : 'save' }}
            </button>
          </div>
        </div>

        <!-- Editor -->
        <div class="surface-1 p-5 space-y-4">
          <div class="grid grid-cols-4 gap-4">
            <label class="block col-span-2">
              <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">name</span>
              <input
                v-model="draft.name"
                class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-3 py-2 text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label class="block">
              <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">symbol</span>
              <input
                v-model="draft.symbol"
                class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-3 py-2 font-mono text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label class="block">
              <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">cadence</span>
              <select
                v-model="draft.cadence"
                class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-3 py-2 font-mono text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
              >
                <option value="1m">1m</option>
                <option value="5m">5m</option>
                <option value="15m">15m</option>
                <option value="1h">1h</option>
                <option value="1d">1d</option>
              </select>
            </label>
          </div>

          <div class="space-y-2">
            <div class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">backtest config</div>
            <div class="grid grid-cols-6 gap-3">
              <label class="block">
                <UTooltip
                  text="Starting cash for backtests. Doesn't affect live trading. Higher capital lets % equity sizing buy more shares per signal but can mask under-capitalised strategies. Typical retail backtest: $10k–$100k."
                  :delay-duration="200"
                >
                  <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] cursor-help underline decoration-dotted decoration-[var(--paper-3)] underline-offset-2">capital ($)</span>
                </UTooltip>
                <input
                  v-model.number="draft.initial_capital"
                  type="number"
                  min="1"
                  step="1000"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label class="block">
                <UTooltip
                  text="Per-trade commission in basis points. 10 bps = 0.10% = $0.10 per $100 traded. Most retail US brokers are 0–10 bps; HK/Asian brokers 10–25 bps. Higher commission punishes high-frequency strategies."
                  :delay-duration="200"
                >
                  <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] cursor-help underline decoration-dotted decoration-[var(--paper-3)] underline-offset-2">commission (bps)</span>
                </UTooltip>
                <input
                  v-model.number="draft.commission_bps"
                  type="number" min="0" max="1000"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label class="block">
                <UTooltip
                  text="Estimated price drift between when a signal fires and when it actually fills. The backtest shifts BUY fills up and SELL fills down by this percentage. 5 bps (0.05%) is typical for liquid stocks; thin names need 20–50+ bps to be honest."
                  :delay-duration="200"
                >
                  <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] cursor-help underline decoration-dotted decoration-[var(--paper-3)] underline-offset-2">slippage (bps)</span>
                </UTooltip>
                <input
                  v-model.number="draft.slippage_bps"
                  type="number" min="0" max="1000"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label class="block">
                <UTooltip
                  text="How signals translate into share counts. fixed qty = same N shares every signal. % equity = N% of current equity (winners compound). fixed $ = $N per signal (rotates capital uniformly). Affects what `sizing value` means."
                  :delay-duration="200"
                >
                  <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] cursor-help underline decoration-dotted decoration-[var(--paper-3)] underline-offset-2">sizing</span>
                </UTooltip>
                <select
                  v-model="draft.sizing_mode"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                >
                  <option value="fixed_qty">fixed qty</option>
                  <option value="pct_equity">% equity</option>
                  <option value="fixed_cash">fixed $</option>
                </select>
              </label>
              <label class="block">
                <UTooltip
                  :text="draft.sizing_mode === 'fixed_qty'
                    ? 'Shares per signal. Strategy buys exactly this many every time it fires (capped at available cash).'
                    : draft.sizing_mode === 'pct_equity'
                      ? 'Percent of current equity per signal. 25 means 25% of (cash + position MTM). Winners compound; losses shrink the next bet.'
                      : 'Dollars per signal. Strategy commits this many dollars each time, dividing by fill price to get shares.'"
                  :delay-duration="200"
                >
                  <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] cursor-help underline decoration-dotted decoration-[var(--paper-3)] underline-offset-2">
                    {{ draft.sizing_mode === 'fixed_qty' ? 'shares' : draft.sizing_mode === 'pct_equity' ? '%' : '$' }}
                  </span>
                </UTooltip>
                <input
                  v-model.number="draft.sizing_value"
                  type="number" min="0.0001" step="0.5"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label class="block">
                <UTooltip
                  text="Max consecutive BUYs without going flat. 1 = never stack (must SELL to flat before re-entering). Higher values let you scale into a position. The cap silently rejects extra BUYs once hit."
                  :delay-duration="200"
                >
                  <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)] cursor-help underline decoration-dotted decoration-[var(--paper-3)] underline-offset-2">pyramid max</span>
                </UTooltip>
                <input
                  v-model.number="draft.pyramiding_max"
                  type="number" min="1" max="100"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
            </div>
          </div>

          <!-- NOTE: This is intentionally a <div>, not a <label>. A <label>
               with no `for` attribute dispatches clicks to its first labeled
               descendant; in diff-review mode the textarea is hidden and the
               first labeled descendant becomes the toolbar's Accept All
               button — every click anywhere in the diff view would fire it. -->
          <div class="block">
            <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">strategy code</span>
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

          <div v-if="saveError" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
            {{ saveError }}
          </div>
        </div>

        <!-- Backtest -->
        <div class="surface-1 p-5 space-y-4">
          <div class="flex items-end justify-between">
            <div>
              <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">backtest</div>
              <div class="text-sm text-[var(--paper-2)] mt-1">
                Daily bars over the last <span class="text-[var(--paper-0)] font-mono">{{ bars }}</span> sessions.
                Saved code is what runs — save your edits first.
              </div>
            </div>
            <div class="flex items-end gap-3">
              <label class="block">
                <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">bars</span>
                <input
                  v-model.number="bars"
                  type="number"
                  min="10"
                  max="2000"
                  class="block w-24 mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-3 py-2 font-mono text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
              <button
                :disabled="backtesting || dirty"
                class="font-mono text-xs uppercase tracking-[0.18em] px-4 py-2 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f] disabled:opacity-60"
                @click="runBacktest"
              >
                {{ backtesting ? 'running…' : 'run backtest' }}
              </button>
            </div>
          </div>
          <div
            v-if="dirty"
            class="font-mono text-xs text-[var(--paper-3)]"
          >save your edits before backtesting — the backend reads from the saved code.</div>

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
        </div>

        <!-- Live signals feed -->
        <div class="surface-1 p-5 space-y-4">
          <div class="flex items-baseline justify-between">
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
              live signals · last 20
            </div>
            <div class="font-mono text-xs text-[var(--paper-3)]">
              auto-refresh every 10s
            </div>
          </div>
          <div v-if="!signals || signals.length === 0" class="font-mono text-xs text-[var(--paper-3)] py-4 text-center">
            no signals yet
            <span v-if="!strategy!.enabled">— go live (paper) to start ticking on cadence</span>
          </div>
          <div v-else class="max-h-72 overflow-y-auto scroll-hidden">
            <table class="w-full font-mono text-xs">
              <thead class="text-[var(--paper-3)] uppercase tracking-wider">
                <tr>
                  <th class="text-left py-1">when</th>
                  <th class="text-left py-1">side</th>
                  <th class="text-right py-1">qty</th>
                  <th class="text-right py-1">price</th>
                  <th class="text-left py-1 pl-4">order / error</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="sig in signals" :key="sig.id" class="border-t border-[rgba(255,245,230,0.06)]">
                  <td class="py-1.5 text-[var(--paper-2)]">{{ shortTs(sig.ts) }}</td>
                  <td
                    class="py-1.5"
                    :class="sig.side === 'BUY' ? 'text-[var(--tape-up)]' : 'text-[var(--tape-down)]'"
                  >{{ sig.side }}</td>
                  <td class="py-1.5 text-right text-[var(--paper-1)]">{{ sig.qty }}</td>
                  <td class="py-1.5 text-right text-[var(--paper-1)]">
                    {{ sig.price !== null ? sig.price.toFixed(2) : '—' }}
                  </td>
                  <td class="py-1.5 pl-4">
                    <span v-if="sig.order_id" class="text-[var(--tape-up)]">▸ {{ sig.order_id }}</span>
                    <span v-else-if="sig.error" class="text-[var(--tape-down)]">{{ sig.error }}</span>
                    <span v-else class="text-[var(--paper-3)]">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        </div>
      </main>

      <!-- Backdrop for the off-canvas sidebar on mobile only. -->
      <div
        v-if="sidebarOpen"
        class="md:hidden fixed inset-0 bg-black/40 z-40"
        @click="sidebarOpen = false"
      />
      <!-- Sidebar: in-flow on md+, off-canvas slide-in on mobile. -->
      <div
        id="strategy-assistant-sidebar"
        class="shrink-0 transition-transform duration-200 md:static md:translate-x-0 md:w-[400px] md:h-auto fixed inset-y-0 right-0 w-[90vw] max-w-[400px] z-50"
        :class="sidebarOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'"
      >
        <div class="relative h-full">
          <button
            class="md:hidden absolute top-2 right-2 z-10 font-mono text-xs uppercase tracking-wider px-2 py-1 text-[var(--paper-3)] hover:text-[var(--accent)]"
            @click="sidebarOpen = false"
            aria-label="close chat"
          >✕</button>
          <StrategyAssistant
            :current-code="draft.code"
            :symbol="draft.symbol"
            :cadence="draft.cadence"
            :active-review-key="activeReview?.blockKey ?? null"
            :finished-review="finishedReview"
            @review="onReview"
            @apply="(code) => { draft.code = code }"
            @apply-config="onApplyConfig"
          />
        </div>
      </div>
    </div>
  </div>
</template>
