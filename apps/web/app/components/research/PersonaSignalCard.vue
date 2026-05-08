<script setup lang="ts">
import { computed } from 'vue'
import type { Signal, SignalDirection } from '../../../types/research'

const props = defineProps<{ signal: Signal }>()

const directionColor = computed<'success' | 'error' | 'neutral'>(() => {
  const map: Record<SignalDirection, 'success' | 'error' | 'neutral'> = {
    bullish: 'success',
    bearish: 'error',
    neutral: 'neutral',
  }
  return map[props.signal.signal]
})

const directionLabel = computed(() => props.signal.signal.toUpperCase())

const confidencePct = computed(() => {
  const v = props.signal.confidence
  const pct = v <= 1 ? v * 100 : v
  return Math.max(0, Math.min(100, Math.round(pct)))
})

const pctClass = computed(() => {
  if (props.signal.signal === 'bullish') return 'tape-up'
  if (props.signal.signal === 'bearish') return 'tape-down'
  return 'text-[var(--paper-2)]'
})

const barClass = computed(() => {
  if (props.signal.signal === 'bullish') return 'bg-[var(--tape-up)]'
  if (props.signal.signal === 'bearish') return 'bg-[var(--tape-down)]'
  return 'bg-[var(--paper-3)]'
})
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 py-3 border-b hairline flex items-baseline justify-between gap-3">
      <div class="flex items-baseline gap-3 min-w-0">
        <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)] truncate">
          {{ props.signal.source }}
        </div>
        <div class="font-mono text-xs text-[var(--paper-3)]" data-mono>
          {{ props.signal.symbol }}
        </div>
      </div>
      <UBadge :color="directionColor" variant="soft" class="font-mono text-xs uppercase tracking-[0.18em]">
        {{ directionLabel }}
      </UBadge>
    </header>

    <div class="px-5 py-3 border-b hairline">
      <div class="flex items-baseline justify-between mb-2">
        <span class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">confidence</span>
        <span class="font-mono text-sm" :class="pctClass" data-mono>{{ confidencePct }}%</span>
      </div>
      <div class="h-1.5 w-full bg-[var(--ink-2)] rounded overflow-hidden">
        <div class="h-full transition-all" :class="barClass" :style="{ width: confidencePct + '%' }" />
      </div>
    </div>

    <div class="px-5 py-3">
      <p class="text-sm text-[var(--paper-2)] leading-relaxed whitespace-pre-wrap">
        {{ props.signal.reasoning }}
      </p>
    </div>
  </div>
</template>
