<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type {
  AlgoBacktestResult,
  AlgoSignal,
  AlgoState,
  AlgoStrategy,
} from '../../../server/llm/http'

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
    await $fetch(`/api/algo/strategies/${id.value}`, {
      method: 'PUT',
      body: draft.value,
    })
    await refresh()
  } catch (e) {
    saveError.value = (e as { data?: { detail?: string } })?.data?.detail
      ?? (e as Error)?.message ?? 'save failed'
  } finally {
    saving.value = false
  }
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
  <div class="h-screen flex flex-col bg-[var(--ink-0)] text-[var(--paper-0)]">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <NuxtLink to="/" class="brand-mark">
          <span>ai</span><span class="text-[var(--paper-0)]">·trader</span>
        </NuxtLink>
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
                <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)]">capital ($)</span>
                <input
                  v-model.number="draft.initial_capital"
                  type="number"
                  min="1"
                  step="1000"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label class="block">
                <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)]">commission (bps)</span>
                <input
                  v-model.number="draft.commission_bps"
                  type="number" min="0" max="1000"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label class="block">
                <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)]">slippage (bps)</span>
                <input
                  v-model.number="draft.slippage_bps"
                  type="number" min="0" max="1000"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label class="block">
                <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)]">sizing</span>
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
                <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)]">
                  {{ draft.sizing_mode === 'fixed_qty' ? 'shares' : draft.sizing_mode === 'pct_equity' ? '%' : '$' }}
                </span>
                <input
                  v-model.number="draft.sizing_value"
                  type="number" min="0.0001" step="0.5"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label class="block">
                <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)]">pyramid max</span>
                <input
                  v-model.number="draft.pyramiding_max"
                  type="number" min="1" max="100"
                  class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-2 py-1.5 font-mono text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
                />
              </label>
            </div>
          </div>

          <label class="block">
            <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">strategy code</span>
            <CodeEditor v-model="draft.code" :rows="18" aria-label="strategy code" class="mt-1" />
          </label>

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

      <div class="w-[400px] shrink-0">
        <StrategyAssistant
          :current-code="draft.code"
          :symbol="draft.symbol"
          :cadence="draft.cadence"
          @apply="(code) => { draft.code = code }"
        />
      </div>
    </div>
  </div>
</template>
