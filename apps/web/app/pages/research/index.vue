<script setup lang="ts">
// Research landing page. The agents pipeline runs at /research/[symbol] —
// this page is the entry point: pick a ticker and jump to the per-symbol
// agents view. Run history is at /research/runs.

import { computed, ref } from 'vue'

definePageMeta({ section: 'research' })
useHead({ title: 'research' })

const symbol = ref('')

const trimmed = computed(() => symbol.value.trim().toUpperCase())
const canGo = computed(() => trimmed.value.length > 0)

function go() {
  if (!canGo.value) return
  navigateTo(`/research/${encodeURIComponent(trimmed.value)}`)
}
</script>

<template>
  <div class="flex-1 flex flex-col min-w-0">
    <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
      <div class="flex items-baseline gap-4">
        <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">research</span>
      </div>
      <div class="flex items-center gap-5">
        <NuxtLink to="/research/runs" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          runs →
        </NuxtLink>
        <NuxtLink to="/algo" class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)]">
          algo →
        </NuxtLink>
      </div>
    </header>

    <main class="flex-1 min-h-0 overflow-y-auto scroll-hidden">
      <div class="max-w-3xl mx-auto px-7 py-14 space-y-8">
        <section class="space-y-3">
          <div class="font-mono text-xs uppercase tracking-[0.22em] text-[var(--paper-3)]">
            agents · multi-agent debate
          </div>
          <h1 class="text-2xl font-medium text-[var(--paper-0)]">
            pick a ticker
          </h1>
          <p class="font-mono text-sm text-[var(--paper-2)] max-w-prose leading-relaxed">
            analysts → bull/bear debate → trader → risk gate. one verdict, full timeline.
          </p>
        </section>

        <section class="surface-1 p-6 space-y-4">
          <label class="flex flex-col gap-2">
            <span class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">symbol</span>
            <SymbolSearchInput
              v-model="symbol"
              placeholder="search NVDA, tencent, 600519…"
              @submit="canGo && go()"
            />
          </label>
          <div class="flex justify-end">
            <button
              type="button"
              class="run-btn"
              :disabled="!canGo"
              @click="go()"
            >
              <span>open · {{ trimmed || '—' }} →</span>
            </button>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
.run-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-weight: 600;
  color: #07080a;
  background: var(--accent);
  border: 1px solid var(--accent);
  padding: 0.65rem 1.1rem;
  border-radius: 6px;
  transition: background-color 160ms ease, border-color 160ms ease, opacity 160ms ease, color 160ms ease;
  cursor: pointer;
  white-space: nowrap;
}
.run-btn:hover:not(:disabled) {
  background: #b88a4f;
  border-color: #b88a4f;
}
.run-btn:disabled {
  background: rgba(212, 169, 106, 0.18);
  border-color: rgba(212, 169, 106, 0.25);
  color: rgba(7, 8, 10, 0.55);
  cursor: not-allowed;
}
</style>