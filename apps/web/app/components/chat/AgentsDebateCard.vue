<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Comark } from '@comark/vue'
import { debateCardView } from '~/utils/debate-card'
import { OWNER_VERDICT_LABEL, confidenceLabel } from '../../../types/agents'

// Bound to the latest output of the `agents_debate` chat tool (see
// server/llm/tools.ts): a progress snapshot per pipeline event, then the
// stored verdict.
const props = defineProps<{ output: unknown; running?: boolean }>()

const view = computed(() => debateCardView(props.output))
const verdict = computed(() => view.value.verdict)
const error = computed(() => view.value.error)

// The verdict output carries no events, so the steps seen while the run
// streamed are kept here.
const steps = ref<string[]>([])
watch(() => view.value.steps, (next) => { if (next.length) steps.value = next }, { immediate: true })

const active = computed(() => props.running && !verdict.value)
const latestStep = computed(() => steps.value.at(-1) ?? null)
// A debater starts once per round; it is one step.
const distinctSteps = computed(() => [...new Set(steps.value)])

const ratingClass: Record<string, string> = {
  'strong-buy': 'bg-emerald-600 text-white',
  buy: 'bg-emerald-500 text-white',
  hold: 'bg-zinc-500 text-white',
  reduce: 'bg-amber-500 text-white',
  sell: 'bg-red-600 text-white',
}
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 py-4 border-b hairline flex items-baseline justify-between gap-4">
      <div class="font-mono text-sm uppercase tracking-[0.2em] text-[var(--paper-3)]">Agents debate</div>
      <div v-if="verdict" class="font-mono text-sm text-[var(--paper-3)]">verdict ready</div>
      <div v-else-if="error" class="font-mono text-sm text-[var(--tape-down)]">failed</div>
      <div v-else-if="active" class="font-mono text-sm text-[var(--accent)]">running</div>
      <div v-else class="font-mono text-sm text-[var(--paper-3)]">{{ distinctSteps.length }} step(s)</div>
    </header>

    <div v-if="active && !steps.length" class="px-5 py-4 border-b hairline">
      <div class="flex items-center justify-between gap-4">
        <div class="font-mono text-sm uppercase tracking-[0.18em] text-[var(--paper-3)]">
          waiting for first event
        </div>
        <span class="size-2 rounded-full bg-[var(--accent)] dot-pulse" />
      </div>
      <div class="mt-3 h-px bg-[var(--ink-2)] overflow-hidden">
        <div class="agent-progress h-full bg-[var(--accent)]" />
      </div>
    </div>

    <ol v-if="steps.length" class="flex flex-wrap gap-2 px-5 py-3 border-b hairline">
      <li
        v-for="step in distinctSteps"
        :key="step"
        class="font-mono text-sm uppercase tracking-[0.15em] text-[var(--paper-2)] px-2 py-1 bg-[var(--ink-2)] rounded"
      >
        {{ step }}
      </li>
    </ol>

    <div v-if="active && latestStep" class="px-5 py-3 border-b hairline flex items-center justify-between gap-4">
      <div class="font-mono text-sm uppercase tracking-[0.18em] text-[var(--paper-3)] truncate">
        active: {{ latestStep }}
      </div>
      <span class="size-2 rounded-full bg-[var(--accent)] dot-pulse shrink-0" />
    </div>

    <div v-if="verdict" class="px-5 py-4 space-y-4">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <span :class="['inline-flex items-center px-2 py-1 rounded font-mono text-sm uppercase tracking-[0.15em]', ratingClass[verdict.rating] ?? 'bg-zinc-500 text-white']">
          {{ verdict.rating }}
        </span>
        <span v-if="verdict.cappedFrom" class="font-mono text-sm text-[var(--paper-2)]">capped from {{ verdict.cappedFrom }}</span>
        <span class="font-mono text-sm text-[var(--paper-3)]">
          {{ verdict.confidence === null ? 'no confidence score' : confidenceLabel(verdict.rating, verdict.confidence) }}
        </span>
      </div>
      <p v-if="verdict.ownerVerdict" class="text-sm text-[var(--paper-2)]" data-testid="debate-owner-verdict">
        For your position: <strong class="font-semibold text-[var(--paper-0)]">{{ OWNER_VERDICT_LABEL[verdict.ownerVerdict] }}</strong>
      </p>
      <p v-if="verdict.capReason" class="text-sm text-[var(--paper-2)]">
        Valuation cap: {{ verdict.capReason }}
      </p>
      <dl v-if="verdict.bullCase || verdict.bearCase" class="grid gap-4 sm:grid-cols-2">
        <div v-if="verdict.bullCase" class="min-w-0">
          <dt class="font-mono text-sm uppercase tracking-[0.15em] text-[var(--tape-up)]">Bull</dt>
          <dd class="mt-1 text-sm text-[var(--paper-1)] break-words">{{ verdict.bullCase }}</dd>
        </div>
        <div v-if="verdict.bearCase" class="min-w-0">
          <dt class="font-mono text-sm uppercase tracking-[0.15em] text-[var(--tape-down)]">Bear</dt>
          <dd class="mt-1 text-sm text-[var(--paper-1)] break-words">{{ verdict.bearCase }}</dd>
        </div>
      </dl>
      <Comark :markdown="verdict.rationale" :options="{ autoClose: false }" class="text-sm text-[var(--paper-1)] *:first:mt-0 *:last:mb-0 prose-invert" />
      <NuxtLink v-if="verdict.runUrl" :to="verdict.runUrl" class="inline-block text-sm text-[var(--accent)] hover:underline">
        {{ verdict.rationaleTruncated ? 'Read the full rationale and reports' : 'Open the full reports' }}
      </NuxtLink>
    </div>
    <div v-if="error" :class="['px-5 py-4 text-sm text-[var(--tape-down)]', verdict ? 'border-t hairline' : '']">
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
