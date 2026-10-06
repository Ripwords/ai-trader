<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FullPortfolio, FullPortfolioAccount } from '../../../server/lib/holdings'
import {
  SOURCE_LABEL,
  fmtCurrency,
  fmtPct,
  fmtQty,
  holdingRows,
  holdingSources,
  partitionAccounts,
  partitionClosed,
  pnlTone,
  sortRows,
  type HoldingSource,
  type SortDir,
  type SortKey,
} from '../../utils/portfolio-view'

const props = defineProps<{ portfolio: FullPortfolio }>()

const sources = computed(() => holdingSources(props.portfolio))
const source = ref<HoldingSource>(sources.value[0] ?? 'all')
watch(sources, (list) => {
  if (!list.includes(source.value)) source.value = list[0] ?? 'all'
})

const sortKey = ref<SortKey>('value')
const sortDir = ref<SortDir>('desc')
function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    return
  }
  sortKey.value = key
  sortDir.value = key === 'symbol' ? 'asc' : 'desc'
}
const ariaSort = (key: SortKey) => sortKey.value !== key ? 'none' : sortDir.value === 'asc' ? 'ascending' : 'descending'
const arrow = (key: SortKey) => sortKey.value !== key ? '' : sortDir.value === 'asc' ? '↑' : '↓'

const showClosed = ref(false)
const split = computed(() => partitionClosed(holdingRows(props.portfolio, source.value)))
const rows = computed(() => sortRows(showClosed.value ? [...split.value.open, ...split.value.closed] : split.value.open, sortKey.value, sortDir.value))
const hasAllocation = computed(() => source.value === 'all')
const maxAllocation = computed(() => Math.max(1, ...split.value.open.map(r => r.allocationPct ?? 0)))

const showEmptyAccounts = ref(false)
const accounts = computed(() => partitionAccounts(props.portfolio.accounts))
const accountRows = computed(() => {
  const funded = [...accounts.value.funded].sort((a, b) => b.value_in_base - a.value_in_base)
  return showEmptyAccounts.value ? [...funded, ...accounts.value.empty] : funded
})

function accountDetail(acc: FullPortfolioAccount): string {
  return [
    acc.platform && acc.platform !== acc.name ? acc.platform : '',
    acc.currency !== props.portfolio.net_worth_currency ? fmtCurrency(acc.balance, acc.currency) : '',
  ].filter(Boolean).join(' · ')
}

const COLUMNS: { key: SortKey, label: string, numeric: boolean }[] = [
  { key: 'symbol', label: 'symbol', numeric: false },
  { key: 'value', label: 'value', numeric: true },
  { key: 'allocation', label: 'weight', numeric: true },
  { key: 'pnl', label: 'p&l', numeric: true },
]
const columns = computed(() => COLUMNS.filter(c => c.key !== 'allocation' || hasAllocation.value))
</script>

<template>
  <div class="space-y-6">
    <section class="surface-1 p-4 sm:p-6 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="label-eyebrow">positions</h2>
        <div v-if="sources.length > 1" class="seg" role="group" aria-label="which accounts">
          <button
            v-for="s in sources"
            :key="s"
            type="button"
            class="seg__btn tap"
            :aria-pressed="source === s"
            @click="source = s"
          >{{ SOURCE_LABEL[s] }}</button>
        </div>
        <span v-else-if="sources.length === 1" class="font-mono text-xs text-[var(--paper-3)]">{{ SOURCE_LABEL[sources[0]!] }}</span>
      </div>

      <PageState v-if="rows.length === 0" kind="empty" message="no open positions in these accounts" />

      <template v-else>
        <table class="holdings hidden sm:table w-full text-sm">
          <thead>
            <tr>
              <th
                v-for="c in columns"
                :key="c.key"
                :aria-sort="ariaSort(c.key)"
                :class="c.numeric ? 'text-right' : 'text-left'"
              >
                <button type="button" class="holdings__sort" @click="setSort(c.key)">
                  {{ c.label }} <span aria-hidden="true">{{ arrow(c.key) }}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.symbol">
              <td class="min-w-0">
                <div class="font-mono text-[var(--paper-0)]" data-mono>{{ r.symbol }}</div>
                <div class="text-xs text-[var(--paper-3)] truncate max-w-[28ch]">
                  {{ r.name ? `${r.name} · ` : '' }}qty {{ fmtQty(r.quantity) }}
                </div>
              </td>
              <td class="text-right font-mono text-[var(--paper-1)]" data-mono>{{ fmtCurrency(r.value, r.currency) }}</td>
              <td v-if="hasAllocation" class="text-right">
                <div class="flex items-center justify-end gap-2">
                  <span class="holdings__bar" aria-hidden="true">
                    <span :style="{ width: `${Math.min(100, ((r.allocationPct ?? 0) / maxAllocation) * 100)}%` }" />
                  </span>
                  <span class="font-mono text-[var(--paper-2)] w-[6ch]" data-mono>{{ (r.allocationPct ?? 0).toFixed(1) }}%</span>
                </div>
              </td>
              <td class="text-right font-mono" :class="`tone-${pnlTone(r.pnlPct)}`" data-mono>{{ fmtPct(r.pnlPct) }}</td>
            </tr>
          </tbody>
        </table>

        <div class="sm:hidden">
          <label class="flex items-center justify-between gap-3 pb-2 border-b hairline font-mono text-xs text-[var(--paper-3)]">
            <span>sort by</span>
            <select v-model="sortKey" class="bg-transparent text-[var(--paper-1)] tap" aria-label="sort positions by">
              <option v-for="c in columns" :key="c.key" :value="c.key">{{ c.label }}</option>
            </select>
          </label>
          <ul>
            <li v-for="r in rows" :key="r.symbol" class="py-3 border-b hairline last:border-0">
              <div class="flex items-baseline justify-between gap-3">
                <span class="font-mono text-[var(--paper-0)] truncate min-w-0" data-mono>{{ r.symbol }}</span>
                <span class="font-mono text-[var(--paper-1)] whitespace-nowrap shrink-0" data-mono>{{ fmtCurrency(r.value, r.currency) }}</span>
              </div>
              <div class="mt-1 flex items-baseline justify-between gap-3 font-mono text-xs">
                <span class="text-[var(--paper-3)] truncate min-w-0">
                  qty {{ fmtQty(r.quantity) }}{{ r.allocationPct != null ? ` · ${r.allocationPct.toFixed(1)}%` : '' }}
                </span>
                <span :class="`tone-${pnlTone(r.pnlPct)}`" data-mono>{{ fmtPct(r.pnlPct) }}</span>
              </div>
            </li>
          </ul>
        </div>
      </template>

      <button
        v-if="split.closed.length > 0"
        type="button"
        class="more tap"
        :aria-expanded="showClosed"
        @click="showClosed = !showClosed"
      >{{ showClosed ? 'hide' : 'show' }} {{ split.closed.length }} closed position{{ split.closed.length === 1 ? '' : 's' }}</button>
    </section>

    <section v-if="portfolio.accounts.length > 0" class="surface-1 p-4 sm:p-6 space-y-3">
      <h2 class="label-eyebrow">accounts</h2>
      <PageState v-if="accountRows.length === 0" kind="empty" message="every account is empty" />
      <ul v-else>
        <li
          v-for="acc in accountRows"
          :key="`${acc.platform}-${acc.name}`"
          class="flex items-baseline justify-between gap-3 py-2.5 border-b hairline last:border-0"
        >
          <div class="min-w-0">
            <div class="text-sm text-[var(--paper-1)] truncate">{{ acc.name }}</div>
            <div v-if="accountDetail(acc)" class="font-mono text-xs text-[var(--paper-3)]">{{ accountDetail(acc) }}</div>
          </div>
          <span class="font-mono text-sm text-[var(--paper-0)] shrink-0" data-mono>{{ fmtCurrency(acc.value_in_base, portfolio.net_worth_currency) }}</span>
        </li>
      </ul>
      <button
        v-if="accounts.empty.length > 0"
        type="button"
        class="more tap"
        :aria-expanded="showEmptyAccounts"
        @click="showEmptyAccounts = !showEmptyAccounts"
      >{{ showEmptyAccounts ? 'hide' : 'show' }} {{ accounts.empty.length }} empty account{{ accounts.empty.length === 1 ? '' : 's' }}</button>
    </section>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--ink-line-strong);
  border-radius: calc(var(--radius-sm) + 2px);
}
.seg__btn {
  padding: 0.3rem 0.65rem;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--paper-3);
  white-space: nowrap;
}
.seg__btn:hover { color: var(--paper-1); }
.seg__btn[aria-pressed='true'] { background: var(--ink-3); color: var(--paper-0); }

.holdings th {
  padding: 0 0 0.5rem;
  border-bottom: 1px solid var(--ink-line);
}
.holdings th + th, .holdings td + td { padding-left: 1rem; }
.holdings td {
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--ink-line);
  vertical-align: middle;
}
.holdings tr:last-child td { border-bottom: 0; }
.holdings__sort {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--paper-3);
  white-space: nowrap;
}
.holdings__sort:hover, .holdings__sort:focus-visible { color: var(--accent); }
.holdings__bar {
  display: inline-block;
  width: 64px;
  height: 4px;
  border-radius: 2px;
  background: var(--ink-3);
  overflow: hidden;
}
.holdings__bar > span {
  display: block;
  height: 100%;
  background: var(--accent);
}

.tone-up { color: var(--tape-up); }
.tone-down { color: var(--tape-down); }
.tone-accent { color: var(--accent); }
.tone-neutral { color: var(--paper-2); }

.more {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.more:hover { color: var(--accent); }
</style>
