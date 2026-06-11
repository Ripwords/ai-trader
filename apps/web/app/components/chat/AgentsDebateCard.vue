<script setup lang="ts">
import type { AgentEvent, Rating } from '~~/types/agents'

// Driven by the `agents_debate` chat tool's async-generator execute (see
// server/llm/tools.ts). Each NDJSON event from the agents pipeline produces
// a preliminary tool-output frame; the chat page binds the latest snapshot
// here so the timeline + verdict update in real time.

interface Verdict { rating: Rating; confidence: number | null; rationale: string }

const props = defineProps<{
  events: AgentEvent[]
  verdict: Verdict | null
  error?: string | null
  running?: boolean
}>()

const nodeStarts = computed(() =>
  props.events
    .filter((e): e is Extract<AgentEvent, { type: 'node-start' }> => e.type === 'node-start')
    .map(e => e.node),
)

const ratingClass: Record<Rating, string> = {
  'strong-buy': 'bg-emerald-600 text-white',
  buy: 'bg-emerald-500 text-white',
  hold: 'bg-zinc-500 text-white',
  reduce: 'bg-amber-500 text-white',
  sell: 'bg-red-600 text-white',
}

const latestNode = computed(() => nodeStarts.value[nodeStarts.value.length - 1] ?? null)
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 py-4 border-b hairline flex items-baseline justify-between">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">Agents debate</div>
      <div v-if="verdict" class="font-mono text-xs text-[var(--paper-3)]">verdict ready</div>
      <div v-else-if="error" class="font-mono text-xs text-[var(--tape-down)]">failed</div>
      <div v-else-if="running" class="font-mono text-xs text-[var(--accent)]">running</div>
      <div v-else class="font-mono text-xs text-[var(--paper-3)]">{{ nodeStarts.length }} step(s)</div>
    </header>

    <div v-if="running && !nodeStarts.length" class="px-5 py-4 border-b hairline">
      <div class="flex items-center justify-between gap-4">
        <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
          waiting for first event
        </div>
        <span class="size-2 rounded-full bg-[var(--accent)] dot-pulse" />
      </div>
      <div class="mt-3 h-px bg-[var(--ink-2)] overflow-hidden">
        <div class="agent-progress h-full bg-[var(--accent)]" />
      </div>
    </div>

    <ol v-if="nodeStarts.length" class="flex flex-wrap gap-2 px-5 py-3 border-b hairline">
      <li
        v-for="(node, i) in nodeStarts"
        :key="`${node}-${i}`"
        class="font-mono text-xs uppercase tracking-[0.15em] text-[var(--paper-2)] px-2 py-1 bg-[var(--ink-2)] rounded"
      >
        {{ node }}
      </li>
    </ol>

    <div v-if="running && latestNode && !verdict" class="px-5 py-3 border-b hairline flex items-center justify-between gap-4">
      <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] truncate">
        active: {{ latestNode }}
      </div>
      <span class="size-2 rounded-full bg-[var(--accent)] dot-pulse shrink-0" />
    </div>

    <div v-if="verdict" class="px-5 py-4 flex items-baseline gap-3">
      <span :class="['inline-flex items-center px-2 py-1 rounded font-mono text-xs uppercase tracking-[0.15em]', ratingClass[verdict.rating]]">
        {{ verdict.rating }}
      </span>
      <span v-if="verdict.confidence !== null" class="font-mono text-xs text-[var(--paper-3)]">conf {{ verdict.confidence }}</span>
      <p class="text-sm text-[var(--paper-1)] flex-1">{{ verdict.rationale }}</p>
    </div>
    <div v-else-if="error" class="px-5 py-4 text-sm text-[var(--tape-down)]">
      {{ error }}
    </div>
  </div>
</template>

<style scoped>
@keyframes agent-progress {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(260%); }
}

.agent-progress {
  width: 38%;
  animation: agent-progress 1.35s ease-in-out infinite;
}
</style>
