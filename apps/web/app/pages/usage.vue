<script setup lang="ts">

definePageMeta({ section: 'usage' })
import { computed } from 'vue'

useHead({ title: 'usage' })

interface UsageRow {
  id: number
  source: string
  modelSpec: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number
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

function formatUsd(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(6)}`
  return `$${n.toFixed(4)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
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
          @click="refresh()"
        >
          refresh
        </button>
      </template>
    </PageHeader>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-6xl mx-auto page-pad space-y-8">
        <div v-if="pending && !data" class="font-mono text-sm text-[var(--paper-3)] text-center py-16">
          loading…
        </div>

        <div v-else-if="error" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
          failed to load usage: {{ error.message }}
        </div>

        <template v-else-if="data">
          <!-- Period totals -->
          <section class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div
              v-for="period in [
                { label: 'today', t: data.summary.totals.today },
                { label: 'last 7 days', t: data.summary.totals.week },
                { label: 'last 30 days', t: data.summary.totals.month },
                { label: 'all time', t: data.summary.totals.allTime },
              ]"
              :key="period.label"
              class="surface-1 p-5 space-y-2"
            >
              <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
                {{ period.label }}
              </div>
              <div class="font-mono stat-value text-[var(--paper-0)]">
                {{ formatUsd(period.t.estimatedCostUsd) }}
              </div>
              <div class="font-mono text-xs text-[var(--paper-3)]">
                {{ period.t.calls }} call{{ period.t.calls === 1 ? '' : 's' }} · {{ formatTokens(period.t.totalTokens) }} tokens
              </div>
            </div>
          </section>

          <!-- Cost by source -->
          <section class="surface-1 p-6 space-y-5">
            <div class="flex items-baseline justify-between">
              <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
                cost by source · last 30d
              </div>
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
              <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">
                recent calls
              </div>
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
                      <td class="px-4 py-2.5 text-[var(--paper-2)]">{{ formatTs(row.ts) }}</td>
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
