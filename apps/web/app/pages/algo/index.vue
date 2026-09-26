<script setup lang="ts">

definePageMeta({ section: 'algo' })
import { ref } from 'vue'
import type { AlgoState, AlgoStrategy, AlgoCadence } from '../../../server/llm/http'
import ConfirmModal from '~/components/settings/ConfirmModal.vue'
import { askConfirm } from '~/lib/confirm'
import { apiErrorMessage } from '~/lib/api-error'

useHead({ title: 'algo' })

const { data, refresh, error: listError } = await useFetch<AlgoStrategy[]>('/api/algo/strategies', {
  default: () => [],
})
const { data: state, error: stateError, refresh: refreshState } = await useFetch<AlgoState>('/api/algo/state')

const actionError = ref<string | null>(null)
const killing = ref(false)

async function toggleKill() {
  actionError.value = null
  killing.value = true
  const path = state.value?.kill_active ? 'unkill' : 'kill'
  try {
    state.value = await $fetch<AlgoState>(`/api/algo/${path}`, { method: 'POST' })
  } catch (e) {
    actionError.value = `kill switch: ${apiErrorMessage(e, 'request failed')}`
  } finally {
    killing.value = false
  }
}

const overlay = useOverlay()

const showNew = ref(false)
const draft = ref<{
  name: string
  symbol: string
  cadence: AlgoCadence
  code: string
}>({
  name: 'My SMA crossover',
  symbol: 'US.NVDA',
  cadence: '1d',
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
    error.value = apiErrorMessage(e, 'failed to create strategy')
  } finally {
    creating.value = false
  }
}

async function remove(id: string, name: string) {
  const ok = await askConfirm(
    props => overlay.create(ConfirmModal, { destroyOnClose: true }).open(props),
    { title: `Delete strategy "${name}"?`, description: 'Its signals and backtest runs are deleted with it.', confirmLabel: 'Delete' },
  )
  if (!ok) return
  actionError.value = null
  try {
    await $fetch(`/api/algo/strategies/${id}`, { method: 'DELETE' })
  } catch (e) {
    actionError.value = `delete "${name}": ${apiErrorMessage(e, 'request failed')}`
  }
  await refresh()
}

function fmt(t: string): string {
  return new Date(t).toISOString().slice(0, 10)
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <PageHeader>
      <template #lead>
        <span>algo</span>
      </template>
      <template #actions>
        <button
          v-if="state"
          :disabled="killing"
          class="px-3 py-2 rounded transition-colors disabled:opacity-60"
          :class="state.kill_active
            ? 'bg-[var(--tape-down)] text-[#07080a]'
            : 'border border-[rgba(255,245,230,0.12)] text-[var(--paper-3)] hover:text-[var(--tape-down)] hover:border-[var(--tape-down)]'"
          @click="toggleKill"
        >{{ state.kill_active ? '◼ kill active' : '◯ kill switch' }}</button>
        <button
          class="px-3 py-2 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f]"
          @click="showNew = !showNew"
        >
          {{ showNew ? 'cancel' : '+ new strategy' }}
        </button>
      </template>
    </PageHeader>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-5xl mx-auto page-pad space-y-8">
        <div
          v-if="listError || stateError || actionError"
          role="alert"
          class="surface-1 p-4 font-mono text-sm text-[var(--tape-down)] space-y-1"
        >
          <div v-if="actionError">{{ actionError }}</div>
          <div v-if="listError">strategies failed to load: {{ apiErrorMessage(listError, 'request failed') }}</div>
          <div v-if="stateError" class="flex items-center gap-3">
            <span>kill switch state failed to load: {{ apiErrorMessage(stateError, 'request failed') }}</span>
            <button class="tap underline text-[var(--paper-2)]" @click="refreshState()">retry</button>
          </div>
        </div>
        <!-- New strategy form -->
        <div v-if="showNew" class="surface-1 p-6 space-y-4">
          <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
            new strategy
          </div>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <label class="block">
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
        <div v-if="!listError && (!data || data.length === 0)" class="font-mono text-sm text-[var(--paper-3)] text-center py-16">
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
                >{{ s.enabled ? '● live (paper)' : '○ paused' }}</span>
              </div>
              <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] mt-1">
                {{ s.symbol }} · {{ s.cadence }} · {{ s.sizing_mode }} {{ s.sizing_value }} · created {{ fmt(s.created_at) }}
              </div>
            </NuxtLink>
            <button
              class="tap font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] hover:text-[var(--tape-down)]"
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
