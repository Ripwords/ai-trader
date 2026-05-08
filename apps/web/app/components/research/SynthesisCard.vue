<script setup lang="ts">
import type { Decision, DecisionAction } from '../../../types/research'

const props = defineProps<{ decisions: Decision[] }>()

function actionColor(action: DecisionAction): 'success' | 'error' | 'warning' | 'neutral' {
  switch (action) {
    case 'buy':
    case 'cover':
      return 'success'
    case 'sell':
    case 'short':
      return 'error'
    case 'hold':
      return 'neutral'
    default:
      return 'warning'
  }
}

function pct(n: number): string {
  const v = n <= 1 ? n * 100 : n
  return `${Math.max(0, Math.min(100, Math.round(v)))}%`
}
</script>

<template>
  <div class="surface-1 rounded-md overflow-hidden">
    <header class="px-5 py-4 border-b hairline flex items-baseline justify-between">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">Synthesis · decisions</div>
      <div class="font-mono text-xs text-[var(--paper-3)]" data-mono>{{ props.decisions.length }} symbols</div>
    </header>

    <div v-if="props.decisions.length === 0" class="px-5 py-6 text-center font-mono text-sm text-[var(--paper-3)]">
      no decisions returned
    </div>

    <div v-else>
      <div class="grid grid-cols-[1fr_0.7fr_0.6fr_0.7fr_2.5fr] gap-3 px-5 py-3 font-mono text-xs uppercase tracking-[0.15em] text-[var(--paper-3)] border-b hairline">
        <div>symbol</div>
        <div>action</div>
        <div class="text-right">qty</div>
        <div class="text-right">conf</div>
        <div>reasoning</div>
      </div>
      <div
        v-for="(d, i) in props.decisions"
        :key="i"
        class="grid grid-cols-[1fr_0.7fr_0.6fr_0.7fr_2.5fr] gap-3 px-5 py-3 border-b hairline last:border-b-0 hover:bg-[var(--ink-2)] transition-colors items-center"
      >
        <div class="font-mono text-base text-[var(--paper-0)]" data-mono>{{ d.symbol }}</div>
        <div>
          <UBadge :color="actionColor(d.action)" variant="soft" class="font-mono text-xs uppercase tracking-[0.18em]">
            {{ d.action }}
          </UBadge>
        </div>
        <div class="font-mono text-base text-[var(--paper-2)] text-right" data-mono>{{ d.quantity }}</div>
        <div class="font-mono text-base text-[var(--paper-2)] text-right" data-mono>{{ pct(d.confidence) }}</div>
        <div class="text-sm text-[var(--paper-2)] leading-snug line-clamp-3">{{ d.reasoning }}</div>
      </div>
    </div>
  </div>
</template>
