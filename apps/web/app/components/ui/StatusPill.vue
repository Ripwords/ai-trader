<script setup lang="ts">
defineProps<{ tone: 'up' | 'down' | 'accent' | 'neutral', label: string }>()
</script>

<template>
  <span class="status-pill">
    <span class="status-pill__dot" :class="`status-pill__dot--${tone}`" aria-hidden="true" />
    <span>{{ label }}</span>
  </span>
</template>

<style scoped>
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--paper-2);
  white-space: nowrap;
}
.status-pill__dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  flex-shrink: 0;
}
.status-pill__dot--up { background: var(--tape-up); }
.status-pill__dot--down { background: var(--tape-down); }
.status-pill__dot--accent { background: var(--accent); }
.status-pill__dot--neutral { background: var(--paper-3); }
</style>
