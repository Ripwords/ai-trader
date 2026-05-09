<script setup lang="ts">

definePageMeta({ section: 'research' })
import { computed, ref } from 'vue'

useHead({ title: 'research runs' })

interface WorkflowRunStep {
  id: string
  status: string
  ms: number
  error?: string
}

interface WorkflowRun {
  id: number
  workflowId: string
  inputSummary: { symbol?: string; analysts?: string[]; personas?: string[] } & Record<string, unknown>
  status: 'success' | 'failed'
  totalMs: number
  steps: WorkflowRunStep[]
  errorMessage: string | null
  startedAt: string
}

const symbolFilter = ref('')
const expanded = ref<Set<number>>(new Set())

const { data, refresh, pending } = await useFetch<{ runs: WorkflowRun[] }>('/api/research/runs', {
  query: { limit: 50 },
  default: () => ({ runs: [] }),
})

const runs = computed<WorkflowRun[]>(() => {
  const all = data.value?.runs ?? []
  const f = symbolFilter.value.trim().toUpperCase()
  if (!f) return all
  return all.filter(r => String(r.inputSummary.symbol ?? '').toUpperCase().includes(f))
})

const last24h = computed(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  return runs.value.filter(r => new Date(r.startedAt).getTime() >= cutoff)
})

const stats = computed(() => {
  const window = last24h.value
  const total = window.length
  if (total === 0) {
    return { total: 0, avgMs: 0, successRate: 0 }
  }
  const sumMs = window.reduce((acc, r) => acc + r.totalMs, 0)
  const ok = window.filter(r => r.status === 'success').length
  return {
    total,
    avgMs: Math.round(sumMs / total),
    successRate: Math.round((ok / total) * 100),
  }
})

function slowestStep(run: WorkflowRun): WorkflowRunStep | null {
  if (!run.steps || run.steps.length === 0) return null
  return run.steps.reduce((worst, s) => (s.ms > worst.ms ? s : worst), run.steps[0]!)
}

function toggle(id: number) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
  expanded.value = new Set(expanded.value)
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toISOString().replace('T', ' ').slice(0, 19)
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research · runs</span>
      </div>
      <div class="flex items-center gap-5">
        <NuxtLink to="/research" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
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
        <!-- Stats -->
        <section class="grid grid-cols-3 gap-4">
          <div class="surface-1 p-5">
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">runs (24h)</div>
            <div class="text-3xl mt-2 font-medium">{{ stats.total }}</div>
          </div>
          <div class="surface-1 p-5">
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">avg duration</div>
            <div class="text-3xl mt-2 font-medium font-mono">{{ fmtMs(stats.avgMs) }}</div>
          </div>
          <div class="surface-1 p-5">
            <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">success rate</div>
            <div
              class="text-3xl mt-2 font-medium font-mono"
              :class="stats.successRate >= 90 ? 'text-[var(--tape-up)]' : stats.successRate >= 50 ? 'text-[var(--paper-0)]' : 'text-[var(--tape-down)]'"
            >{{ stats.successRate }}%</div>
          </div>
        </section>

        <!-- Filter -->
        <section class="flex items-end gap-4">
          <label class="block flex-1 max-w-xs">
            <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">filter symbol</span>
            <input
              v-model="symbolFilter"
              placeholder="US.NVDA"
              class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-3 py-2 font-mono text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
            />
          </label>
          <div class="font-mono text-xs text-[var(--paper-3)] pb-2">
            {{ runs.length }} {{ runs.length === 1 ? 'run' : 'runs' }}
          </div>
        </section>

        <!-- Runs table -->
        <section v-if="runs.length === 0" class="font-mono text-sm text-[var(--paper-3)] text-center py-16">
          no workflow runs yet — invoke <span class="text-[var(--accent)]">analyze_ticker</span> to generate one.
        </section>

        <section v-else class="surface-1 overflow-hidden">
          <div class="grid grid-cols-[12rem_8rem_6rem_6rem_1fr_3rem] gap-4 px-5 py-3 border-b hairline font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
            <div>started</div>
            <div>symbol</div>
            <div>status</div>
            <div class="text-right">total</div>
            <div>slowest step</div>
            <div></div>
          </div>

          <div
            v-for="run in runs"
            :key="run.id"
            class="border-b hairline last:border-0"
          >
            <button
              type="button"
              class="w-full grid grid-cols-[12rem_8rem_6rem_6rem_1fr_3rem] gap-4 px-5 py-3 hover:bg-[rgba(255,245,230,0.02)] transition-colors text-left items-center"
              @click="toggle(run.id)"
            >
              <div class="font-mono text-xs text-[var(--paper-2)]">{{ fmtTime(run.startedAt) }}</div>
              <div class="font-mono text-sm text-[var(--paper-0)]">{{ run.inputSummary.symbol ?? '—' }}</div>
              <div>
                <span
                  class="font-mono text-xs uppercase tracking-wider px-2 py-1 rounded"
                  :class="run.status === 'success'
                    ? 'text-[var(--tape-up)] border border-[rgba(82,191,98,0.25)]'
                    : 'text-[var(--tape-down)] border border-[rgba(214,82,68,0.25)]'"
                >{{ run.status === 'success' ? '● ok' : '✕ failed' }}</span>
              </div>
              <div class="font-mono text-sm text-right">{{ fmtMs(run.totalMs) }}</div>
              <div class="font-mono text-xs text-[var(--paper-2)] truncate">
                <template v-if="slowestStep(run)">
                  {{ slowestStep(run)!.id }}
                  <span class="text-[var(--paper-3)]">·</span>
                  {{ fmtMs(slowestStep(run)!.ms) }}
                </template>
                <template v-else>
                  <span class="text-[var(--paper-3)]">—</span>
                </template>
              </div>
              <div class="font-mono text-xs text-[var(--paper-3)] text-right">
                {{ expanded.has(run.id) ? '▼' : '▶' }}
              </div>
            </button>

            <div v-if="expanded.has(run.id)" class="px-5 py-4 bg-[rgba(255,245,230,0.02)] space-y-3">
              <div v-if="run.errorMessage" class="font-mono text-xs text-[var(--tape-down)] whitespace-pre-wrap">
                {{ run.errorMessage }}
              </div>

              <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
                steps · {{ run.steps.length }}
              </div>

              <div v-if="run.steps.length === 0" class="font-mono text-xs text-[var(--paper-3)]">
                no per-step timing recorded
              </div>

              <div v-else class="space-y-1">
                <div
                  v-for="step in run.steps"
                  :key="step.id"
                  class="grid grid-cols-[1fr_6rem_5rem] gap-4 items-center font-mono text-xs"
                >
                  <div class="text-[var(--paper-1)]">{{ step.id }}</div>
                  <div class="text-right text-[var(--paper-2)]">{{ fmtMs(step.ms) }}</div>
                  <div
                    class="text-right uppercase tracking-wider"
                    :class="step.status === 'success'
                      ? 'text-[var(--tape-up)]'
                      : step.status === 'failed'
                        ? 'text-[var(--tape-down)]'
                        : 'text-[var(--paper-3)]'"
                  >{{ step.status }}</div>
                  <div v-if="step.error" class="col-span-3 text-[var(--tape-down)] whitespace-pre-wrap pl-3">
                    {{ step.error }}
                  </div>
                </div>
              </div>

              <div class="font-mono text-xs text-[var(--paper-3)] pt-2">
                <span v-if="run.inputSummary.analysts">
                  analysts: {{ (run.inputSummary.analysts as string[]).join(', ') }}
                </span>
                <span v-if="run.inputSummary.personas" class="ml-4">
                  personas: {{ (run.inputSummary.personas as string[]).join(', ') }}
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>
