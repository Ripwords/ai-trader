<script setup lang="ts">
import type { AgentEvent, Rating } from '~~/types/agents'

// TODO(task-11+): wire this card into chat.post.ts via a custom data part.
// Today the agents_debate tool returns only the final verdict to the LLM
// (chat.post.ts has no per-tool streaming-data hook). To stream live events
// into this component, the chat handler will need to forward intermediate
// NDJSON events as `dataParts` (e.g. via `streamText({ experimental_dataStream })`)
// or expose them through a sibling SSE channel. Until then, this component is
// a no-op placeholder rendered by the eventual integration layer.

interface Verdict { rating: Rating; confidence: number; rationale: string }

const props = defineProps<{
  events: AgentEvent[]
  verdict: Verdict | null
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
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 py-4 border-b hairline flex items-baseline justify-between">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">Agents debate</div>
      <div v-if="verdict" class="font-mono text-xs text-[var(--paper-3)]">verdict ready</div>
      <div v-else class="font-mono text-xs text-[var(--paper-3)]">{{ nodeStarts.length }} step(s)</div>
    </header>

    <ol v-if="nodeStarts.length" class="flex flex-wrap gap-2 px-5 py-3 border-b hairline">
      <li
        v-for="(node, i) in nodeStarts"
        :key="`${node}-${i}`"
        class="font-mono text-xs uppercase tracking-[0.15em] text-[var(--paper-2)] px-2 py-1 bg-[var(--ink-2)] rounded"
      >
        {{ node }}
      </li>
    </ol>

    <div v-if="verdict" class="px-5 py-4 flex items-baseline gap-3">
      <span :class="['inline-flex items-center px-2 py-1 rounded font-mono text-xs uppercase tracking-[0.15em]', ratingClass[verdict.rating]]">
        {{ verdict.rating }}
      </span>
      <span class="font-mono text-xs text-[var(--paper-3)]">conf {{ verdict.confidence }}</span>
      <p class="text-sm text-[var(--paper-1)] flex-1">{{ verdict.rationale }}</p>
    </div>
  </div>
</template>
