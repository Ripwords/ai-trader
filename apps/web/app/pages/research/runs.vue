<script setup lang="ts">
import { computed, ref } from 'vue'

definePageMeta({ section: 'research' })

useHead({ title: 'agent runs' })

interface AgentRunRow {
  id: string
  symbol: string
  tradeDate: string
  status: string
  rating: string | null
  confidence: number | null
  alpha: string | null
  outcome: string | null
  costUsd: string | null
  startedAt: string
  finishedAt: string | null
}

const symbolFilter = ref('')

const { data, refresh, pending } = useLazyFetch<{ rows: AgentRunRow[] }>('/api/research/agent-runs', {
  default: () => ({ rows: [] }),
})

const runs = computed(() => {
  const all = data.value?.rows ?? []
  const f = symbolFilter.value.trim().toUpperCase()
  const filtered = f ? all.filter(r => r.symbol.toUpperCase().includes(f)) : all
  return filtered.map(r => ({
    ...r,
    costUsd: r.costUsd === null || r.costUsd === undefined ? null : Number(r.costUsd),
  }))
})

const stats = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const window = runs.value.filter(r => new Date(r.startedAt).getTime() >= cutoff)
  if (window.length === 0) return { total: 0, avgCost: 0, completedRate: 0 }
  const completed = window.filter(r => r.status === 'complete').length
  const costs = window.map(r => (typeof r.costUsd === 'number' ? r.costUsd : 0))
  const sumCost = costs.reduce((a, b) => a + b, 0)
  return {
    total: window.length,
    avgCost: sumCost / window.length,
    completedRate: Math.round((completed / window.length) * 100),
  }
})

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research · agent runs</span>
      </div>
      <div class="flex items-center gap-5">
        <NuxtLink
          to="/research"
          class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]"
        >
          ← research
        </NuxtLink>
        <button
          :disabled="pending"
          class="font-mono text-xs uppercase tracking-[0.18em] px-3 py-2 border border-[rgba(255,245,230,0.12)] text-[var(--paper-3)] hover:text-[var(--accent)] hover:border-[var(--accent)] rounded transition-colors disabled:opacity-60"
          @click="refresh()"
        >
          {{ pending ? 'refreshing…' : '↻ refresh' }}
        </button>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-6xl mx-auto px-7 py-8 space-y-8">
        <section class="grid grid-cols-3 gap-4">
          <div class="surface-1 p-5">
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">runs (24h)</div>
            <div class="text-3xl mt-2 font-medium">{{ stats.total }}</div>
          </div>
          <div class="surface-1 p-5">
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">avg cost</div>
            <div class="text-3xl mt-2 font-medium font-mono">{{ fmtCost(stats.avgCost) }}</div>
          </div>
          <div class="surface-1 p-5">
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">completion rate</div>
            <div
              class="text-3xl mt-2 font-medium font-mono"
              :class="stats.completedRate >= 90 ? 'text-[var(--tape-up)]' : stats.completedRate >= 50 ? 'text-[var(--paper-0)]' : 'text-[var(--tape-down)]'"
            >{{ stats.completedRate }}%</div>
          </div>
        </section>

        <section class="flex items-end gap-4">
          <label class="block flex-1 max-w-xs">
            <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">filter symbol</span>
            <input
              v-model="symbolFilter"
              placeholder="NVDA"
              class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-3 py-2 font-mono text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
            />
          </label>
          <div class="font-mono text-xs text-[var(--paper-3)] pb-2">
            {{ runs.length }} {{ runs.length === 1 ? 'run' : 'runs' }}
          </div>
        </section>

        <RunHistoryTable :rows="runs" />
      </div>
    </main>
  </div>
</template>
