<script setup lang="ts">
/* Hallmark · genre: modern-minimal · macrostructure: breadcrumb header, 24h key-figure strip, filterable run table · design-system: design.md · designed-as-app */
import { computed, ref } from 'vue'
import { apiErrorMessage } from '~/lib/api-error'
import { fmtRate, fmtUsd, rateTone, runStats } from '~/utils/research-view'

definePageMeta({ section: 'research' })

useHead({ title: 'agent runs' })

interface AgentRunRow {
  id: string
  symbol: string
  tradeDate: string
  status: string
  rating: string | null
  confidence: number | null
  costUsd: string | null
  startedAt: string
  finishedAt: string | null
}

const symbolFilter = ref('')

const { data, refresh, status, error } = useLazyFetch<{ rows: AgentRunRow[] }>('/api/research/agent-runs')

const loading = computed(() => status.value === 'pending' && !data.value)

const runs = computed(() => {
  const all = data.value?.rows ?? []
  const f = symbolFilter.value.trim().toUpperCase()
  const filtered = f ? all.filter(r => r.symbol.toUpperCase().includes(f)) : all
  return filtered.map(r => ({
    ...r,
    costUsd: r.costUsd == null ? null : Number(r.costUsd),
  }))
})

const stats = computed(() => runStats(runs.value, Date.now()))
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <PageHeader>
      <template #lead>
        <nav class="crumb" aria-label="breadcrumb">
          <NuxtLink to="/research" class="crumb__link">research</NuxtLink>
          <span class="crumb__sep" aria-hidden="true">/</span>
          <span class="crumb__leaf" aria-current="page">agent runs</span>
        </nav>
      </template>
      <template #actions>
        <UButton
          variant="ghost"
          color="neutral"
          size="sm"
          icon="i-lucide-refresh-cw"
          :loading="status === 'pending'"
          @click="refresh()"
        >
          refresh
        </UButton>
      </template>
    </PageHeader>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-6xl mx-auto page-pad space-y-6">
        <PageState v-if="loading" kind="loading" message="loading agent runs…" />
        <PageState
          v-else-if="error"
          kind="error"
          :message="apiErrorMessage(error, 'could not load agent runs')"
          @retry="refresh()"
        />
        <template v-else>
          <section class="grid grid-cols-2 min-[520px]:grid-cols-3 gap-4">
            <StatTile label="runs (24h)" :value="String(stats.total)" size="lg" />
            <StatTile label="avg cost (24h)" :value="fmtUsd(stats.avgCost)" size="lg" />
            <StatTile
              label="completion rate (24h)"
              :value="fmtRate(stats.completionRate)"
              :tone="rateTone(stats.completionRate)"
              size="lg"
            />
          </section>

          <section class="flex items-end gap-4">
            <label class="block flex-1 max-w-xs">
              <span class="label-eyebrow">filter symbol</span>
              <UInput v-model="symbolFilter" placeholder="NVDA" class="mt-1 w-full" :ui="{ base: 'font-mono' }" />
            </label>
            <div class="font-mono text-xs text-[var(--paper-3)] pb-2">
              {{ runs.length }} {{ runs.length === 1 ? 'run' : 'runs' }}
            </div>
          </section>

          <PageState
            v-if="(data?.rows.length ?? 0) === 0"
            kind="empty"
            message="no agent runs yet. open a ticker from research to start one."
          />
          <PageState
            v-else-if="runs.length === 0"
            kind="empty"
            :message="`no runs match ${symbolFilter.trim().toUpperCase()}`"
          />
          <RunHistoryTable v-else :rows="runs" />
        </template>
      </div>
    </main>
  </div>
</template>

<style scoped>
.crumb {
  display: flex;
  align-items: baseline;
  gap: 0.7rem;
}
.crumb__link {
  color: var(--paper-3);
  text-decoration: none;
  transition: color 140ms ease;
}
.crumb__link:hover { color: var(--accent); }
.crumb__sep { color: var(--paper-3); }
.crumb__leaf { color: var(--paper-0); }
@media (pointer: coarse) {
  .crumb__link { position: relative; }
  .crumb__link::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 100%;
    min-width: 44px;
    height: 44px;
  }
}
</style>
