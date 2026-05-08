<script setup lang="ts">
import { ref } from 'vue'
import type { AlgoState, AlgoStrategy, AlgoCadence } from '../../../server/llm/http'

useHead({ title: 'algo' })

const { data, refresh } = await useFetch<AlgoStrategy[]>('/api/algo/strategies', {
  default: () => [],
})
const { data: state } = await useFetch<AlgoState>('/api/algo/state')

async function toggleKill() {
  const path = state.value?.kill_active ? 'unkill' : 'kill'
  state.value = await $fetch<AlgoState>(`/api/algo/${path}`, { method: 'POST' })
}

const showNew = ref(false)
const draft = ref<{
  name: string
  symbol: string
  cadence: AlgoCadence
  qty_per_signal: number
  code: string
}>({
  name: 'My SMA crossover',
  symbol: 'US.NVDA',
  cadence: '1d',
  qty_per_signal: 1,
  code: `# Buy on simple up-bar momentum, hold otherwise.
def on_bar(c):
    closes = c.bars['close']
    if len(closes) >= 2 and closes.iloc[-1] > closes.iloc[-2]:
        c.buy(c.qty)
    else:
        c.hold()
`,
})
const error = ref<string | null>(null)
const creating = ref(false)

async function createStrategy() {
  error.value = null
  creating.value = true
  try {
    const created = await $fetch<AlgoStrategy>('/api/algo/strategies', {
      method: 'POST',
      body: draft.value,
    })
    showNew.value = false
    await refresh()
    await navigateTo(`/algo/${created.id}`)
  } catch (e) {
    const msg = (e as { data?: { detail?: string }, message?: string })?.data?.detail
      ?? (e as Error)?.message
      ?? 'failed to create strategy'
    error.value = String(msg)
  } finally {
    creating.value = false
  }
}

async function remove(id: string, name: string) {
  if (!confirm(`Delete strategy "${name}"?`)) return
  await $fetch(`/api/algo/strategies/${id}`, { method: 'DELETE' })
  await refresh()
}

function fmt(t: string): string {
  return new Date(t).toISOString().slice(0, 10)
}
</script>

<template>
  <div class="h-screen flex flex-col bg-[var(--ink-0)] text-[var(--paper-0)]">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <NuxtLink to="/" class="brand-mark">
          <span>ai</span><span class="text-[var(--paper-0)]">·trader</span>
        </NuxtLink>
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">algo</span>
      </div>
      <div class="flex items-center gap-5">
        <button
          v-if="state"
          class="font-mono text-xs uppercase tracking-[0.18em] px-3 py-2 rounded transition-colors"
          :class="state.kill_active
            ? 'bg-[var(--tape-down)] text-[#07080a]'
            : 'border border-[rgba(255,245,230,0.12)] text-[var(--paper-3)] hover:text-[var(--tape-down)] hover:border-[var(--tape-down)]'"
          @click="toggleKill"
        >{{ state.kill_active ? '◼ kill active' : '◯ kill switch' }}</button>
        <NuxtLink to="/" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          ← chat
        </NuxtLink>
        <button
          class="font-mono text-xs uppercase tracking-[0.18em] px-3 py-2 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f]"
          @click="showNew = !showNew"
        >
          {{ showNew ? 'cancel' : '+ new strategy' }}
        </button>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-5xl mx-auto px-7 py-8 space-y-8">
        <!-- New strategy form -->
        <div v-if="showNew" class="surface-1 p-6 space-y-4">
          <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
            new strategy
          </div>
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
            <label class="block">
              <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">qty/signal</span>
              <input
                v-model.number="draft.qty_per_signal"
                type="number"
                min="1"
                class="block w-full mt-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-3 py-2 font-mono text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)]"
              />
            </label>
          </div>

          <label class="block">
            <span class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]">strategy code</span>
            <CodeEditor v-model="draft.code" :rows="14" aria-label="strategy code" class="mt-1" />
          </label>

          <div v-if="error" class="font-mono text-sm text-[var(--tape-down)] whitespace-pre-wrap">
            {{ error }}
          </div>

          <button
            :disabled="creating"
            class="font-mono text-xs uppercase tracking-[0.18em] px-4 py-2 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f] disabled:opacity-60"
            @click="createStrategy"
          >
            {{ creating ? 'creating…' : 'create' }}
          </button>
        </div>

        <!-- Existing strategies -->
        <div v-if="!data || data.length === 0" class="font-mono text-sm text-[var(--paper-3)] text-center py-16">
          no strategies yet — click <span class="text-[var(--accent)]">+ new strategy</span> to author one.
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="s in data"
            :key="s.id"
            class="surface-1 p-5 hover:border-[var(--accent)] transition-colors flex items-center justify-between"
          >
            <NuxtLink :to="`/algo/${s.id}`" class="flex-1 min-w-0">
              <div class="flex items-baseline gap-3">
                <div class="text-base font-medium text-[var(--paper-0)]">{{ s.name }}</div>
                <span
                  class="font-mono text-xs uppercase tracking-wider"
                  :class="s.enabled ? 'text-[var(--tape-up)]' : 'text-[var(--paper-3)]'"
                >{{ s.enabled ? '● live' : '○ paused' }}</span>
              </div>
              <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mt-1">
                {{ s.symbol }} · {{ s.cadence }} · qty {{ s.qty_per_signal }} · created {{ fmt(s.created_at) }}
              </div>
            </NuxtLink>
            <button
              class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] hover:text-[var(--tape-down)]"
              @click.stop="remove(s.id, s.name)"
            >
              delete
            </button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
