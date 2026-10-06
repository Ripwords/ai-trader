<script setup lang="ts">
/* Hallmark · genre: modern-minimal · macrostructure: page header, key-figure strip led by 30-day cost, cost-by-source bars, recent-calls table · design-system: design.md · designed-as-app */

definePageMeta({ section: 'usage' })
import { computed } from 'vue'
import { formatUsdCost as formatUsd } from '../utils/usage-view'

useHead({ title: 'usage' })

interface UsageRow {
  id: number
  source: string
  modelSpec: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  ts: string
}

interface BreakdownRow {
  source: string
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

interface PeriodTotals {
  calls: number
  totalTokens: number
  estimatedCostUsd: number
}

interface UsageResponse {
  summary: {
    totals: {
      today: PeriodTotals
      week: PeriodTotals
      month: PeriodTotals
      allTime: PeriodTotals
    }
    bySource: BreakdownRow[]
  }
  recent: UsageRow[]
}

const { data, pending, error, refresh } = useLazyFetch<UsageResponse>('/api/usage')

const maxCost = computed(() => {
  const rows = data.value?.summary.bySource ?? []
  return rows.reduce((m, r) => Math.max(m, r.estimatedCostUsd), 0)
})

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function callsAndTokens(t: PeriodTotals): string {
  return `${t.calls} call${t.calls === 1 ? '' : 's'} · ${formatTokens(t.totalTokens)} tokens`
}

function barWidth(cost: number): string {
  if (maxCost.value === 0) return '0%'
  return `${Math.max(2, (cost / maxCost.value) * 100)}%`
}

function sourceColor(source: string): string {
  if (source === 'chat') return 'var(--accent)'
  if (source.startsWith('persona:')) return 'var(--paper-2)'
  return 'var(--paper-3)'
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <PageHeader>
      <template #lead>
        <span>usage</span>
      </template>
      <template #actions>
        <button
          class="text-[var(--paper-3)] hover:text-[var(--accent)]"
          :disabled="pending"
          @click="refresh()"
        >
          refresh
        </button>
      </template>
    </PageHeader>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-6xl mx-auto page-pad space-y-6">
        <PageState v-if="pending && !data" kind="loading" message="loading usage…" />
        <PageState v-else-if="error" kind="error" :message="`usage failed to load: ${error.message}`" @retry="refresh()" />

        <template v-else-if="data">
          <section class="surface-1 p-4 sm:p-5 space-y-5" aria-label="spend">
            <StatTile
              label="last 30 days"
              size="lg"
              :value="formatUsd(data.summary.totals.month.estimatedCostUsd)"
              :sub="`${data.summary.totals.month.calls} call${data.summary.totals.month.calls === 1 ? '' : 's'}`"
            />
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-5 border-t hairline pt-5">
              <StatTile label="today" :value="formatUsd(data.summary.totals.today.estimatedCostUsd)" :sub="callsAndTokens(data.summary.totals.today)" />
              <StatTile label="last 7 days" :value="formatUsd(data.summary.totals.week.estimatedCostUsd)" :sub="callsAndTokens(data.summary.totals.week)" />
              <StatTile label="all time" :value="formatUsd(data.summary.totals.allTime.estimatedCostUsd)" :sub="callsAndTokens(data.summary.totals.allTime)" />
              <StatTile label="tokens" :value="formatTokens(data.summary.totals.month.totalTokens)" sub="last 30 days" />
            </div>
          </section>

          <!-- Cost by source -->
          <section class="surface-1 p-4 sm:p-5 space-y-5">
            <div class="flex items-baseline justify-between">
              <h2 class="label-eyebrow">cost by source · last 30d</h2>
              <div class="font-mono text-xs text-[var(--paper-3)]">
                {{ data.summary.bySource.length }} source{{ data.summary.bySource.length === 1 ? '' : 's' }}
              </div>
            </div>

            <div v-if="data.summary.bySource.length === 0" class="font-mono text-sm text-[var(--paper-3)] text-center py-8">
              no usage recorded yet — start a chat or run research.
            </div>

            <div v-else class="space-y-3">
              <div
                v-for="row in data.summary.bySource"
                :key="row.source"
                class="space-y-1"
              >
                <div class="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4 font-mono text-xs">
                  <span class="text-[var(--paper-1)]">{{ row.source }}</span>
                  <span class="text-[var(--paper-3)]">
                    {{ formatUsd(row.estimatedCostUsd) }} · {{ row.calls }} call{{ row.calls === 1 ? '' : 's' }} · {{ formatTokens(row.totalTokens) }} tokens
                  </span>
                </div>
                <div class="h-2 bg-[var(--ink-1)] rounded-sm overflow-hidden">
                  <div
                    class="h-full transition-[width] duration-300"
                    :style="{ width: barWidth(row.estimatedCostUsd), backgroundColor: sourceColor(row.source) }"
                  />
                </div>
              </div>
            </div>
          </section>

          <!-- Recent calls -->
          <section class="space-y-4">
            <div class="flex items-baseline justify-between">
              <h2 class="label-eyebrow">recent calls</h2>
              <div class="font-mono text-xs text-[var(--paper-3)]">{{ data.recent.length }} rows</div>
            </div>

            <div v-if="data.recent.length === 0" class="font-mono text-sm text-[var(--paper-3)] text-center py-8">
              no calls yet.
            </div>

            <div v-else class="surface-1 overflow-hidden">
              <div class="table-scroll">
                <table class="w-full font-mono text-xs">
                  <thead>
                    <tr class="text-[var(--paper-3)] uppercase tracking-wider border-b hairline">
                      <th class="text-left px-4 py-3">when</th>
                      <th class="text-left px-4 py-3">source</th>
                      <th class="text-left px-4 py-3">model</th>
                      <th class="text-right px-4 py-3">in</th>
                      <th class="text-right px-4 py-3">out</th>
                      <th class="text-right px-4 py-3">total</th>
                      <th class="text-right px-4 py-3">cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="row in data.recent"
                      :key="row.id"
                      class="border-b hairline last:border-b-0"
                    >
                      <td class="px-4 py-2.5 text-[var(--paper-2)]"><NuxtTime :datetime="row.ts" month="short" day="numeric" hour="2-digit" minute="2-digit" /></td>
                      <td class="px-4 py-2.5 text-[var(--paper-1)]">{{ row.source }}</td>
                      <td class="px-4 py-2.5 text-[var(--paper-3)]">{{ row.modelSpec }}</td>
                      <td class="px-4 py-2.5 text-right text-[var(--paper-2)]">{{ formatTokens(row.inputTokens) }}</td>
                      <td class="px-4 py-2.5 text-right text-[var(--paper-2)]">{{ formatTokens(row.outputTokens) }}</td>
                      <td class="px-4 py-2.5 text-right text-[var(--paper-1)]">{{ formatTokens(row.totalTokens) }}</td>
                      <td class="px-4 py-2.5 text-right text-[var(--paper-0)]">{{ formatUsd(row.estimatedCostUsd) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </template>
      </div>
    </main>
  </div>
</template>
