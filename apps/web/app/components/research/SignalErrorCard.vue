<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  source: string
  message: string
}>()

const label = computed(() => props.source.toUpperCase())
</script>

<template>
  <div class="err-card rounded-md overflow-hidden">
    <header class="px-5 py-3 border-b err-hairline flex items-baseline justify-between gap-3">
      <div class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)] truncate">
        {{ label }}
      </div>
      <div class="font-mono text-xs uppercase tracking-[0.18em] flex items-baseline gap-1 text-[var(--tape-down)]">
        <span aria-hidden="true">×</span>
        <span>error</span>
      </div>
    </header>
    <div class="px-5 py-4 space-y-2">
      <div class="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-[var(--tape-down)] opacity-80">
        unrecovered
      </div>
      <p class="font-mono text-xs text-[var(--paper-2)] whitespace-pre-wrap leading-relaxed">
        {{ message || 'no detail returned' }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.err-card {
  background: color-mix(in srgb, var(--tape-down) 4%, var(--ink-1, #0d0f12));
  border: 1px solid color-mix(in srgb, var(--tape-down) 32%, transparent);
}
.err-hairline { border-bottom-color: color-mix(in srgb, var(--tape-down) 22%, transparent); }
</style>
