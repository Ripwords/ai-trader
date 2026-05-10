<script setup lang="ts">
import type { RiskCardTone } from '../../../types/research'

defineProps<{ kpis: { label: string, value: string, tone: RiskCardTone }[] }>()
</script>

<template>
  <section class="kpis surface-1">
    <div
      v-for="(k, i) in kpis"
      :key="i"
      class="kpi"
      :data-tone="k.tone"
    >
      <div class="label">{{ k.label }}</div>
      <div class="value" data-mono>{{ k.value }}</div>
    </div>
  </section>
</template>

<style scoped>
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0;
  padding: 0;
  border-radius: 6px;
  overflow: hidden;
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 1rem 1.1rem;
  border-right: 1px solid var(--ink-line);
  position: relative;
}
.kpi:last-child { border-right: none; }
.kpi::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--paper-3);
  opacity: 0.35;
}
.kpi[data-tone="beat"]::before    { background: var(--tape-up);   opacity: 0.9; }
.kpi[data-tone="miss"]::before    { background: var(--tape-down); opacity: 0.9; }
.kpi[data-tone="caution"]::before { background: var(--accent);    opacity: 0.85; }

.label {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.value {
  font-family: var(--font-mono);
  font-size: 1.25rem;
  color: var(--paper-0);
  letter-spacing: 0.02em;
}
.kpi[data-tone="beat"] .value    { color: var(--tape-up); }
.kpi[data-tone="miss"] .value    { color: var(--tape-down); }
.kpi[data-tone="caution"] .value { color: var(--accent); }
</style>
