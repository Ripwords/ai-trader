<script setup lang="ts">
import type { AlgoMaturityCheck, AlgoMaturityStatus } from '../../../server/lib/algo-risk'

defineProps<{ check: AlgoMaturityCheck }>()

const STATUS_CLASS: Record<AlgoMaturityStatus, string> = {
  block: 'text-[var(--tape-down)]',
  warn: 'text-[var(--accent)]',
  pass: 'text-[var(--tape-up)]',
}
</script>

<template>
  <li class="py-3 first:pt-0 last:pb-0">
    <div class="flex items-baseline justify-between gap-3">
      <span class="label-eyebrow">{{ check.label }}</span>
      <span class="font-mono text-[11px] uppercase tracking-[0.14em]" :class="STATUS_CLASS[check.status]" data-mono>
        {{ check.status }}
      </span>
    </div>
    <p class="mt-1 text-xs text-[var(--paper-2)]">{{ check.note }}</p>
  </li>
</template>
