<script setup lang="ts">

definePageMeta({ section: 'portfolio' })
import { computed, ref } from 'vue'
import type { FullPortfolio, FullPortfolioPosition } from '../../../server/lib/holdings'

useHead({ title: 'portfolio' })

// Backend caches /api/portfolio (SWR 60s/10min). The refresh button below
// sets ?force=1 to bypass the cache for an explicit hard-refresh.
const force = ref(0)
const { data, pending, error, refresh } = useLazyFetch<FullPortfolio>('/api/portfolio', {
  server: true,
  query: computed(() => (force.value ? { force: '1', _t: force.value } : {})),
})
function hardRefresh() {
  force.value = Date.now()
  refresh()
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

const baseCcy = computed(() => data.value?.net_worth_currency ?? 'MYR')
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
