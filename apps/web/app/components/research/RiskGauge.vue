<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ score: number }>()

const clamped = computed(() => Math.max(0, Math.min(100, props.score)))

const tone = computed(() => {
  if (clamped.value >= 70) return 'up'
  if (clamped.value <= 35) return 'down'
  return 'caution'
})

const label = computed(() => {
  if (clamped.value >= 80) return 'low risk'
  if (clamped.value >= 60) return 'moderate'
  if (clamped.value >= 40) return 'elevated'
  if (clamped.value >= 20) return 'high risk'
  return 'severe risk'
})

// SVG arc geometry: 180° from -90° to 90°, radius 70, stroke 14
const RADIUS = 70
const CIRC = Math.PI * RADIUS
const dash = computed(() => `${(clamped.value / 100) * CIRC} ${CIRC}`)
</script>

<template>
  <section class="gauge surface-1" :data-tone="tone">
    <div class="eyebrow">risk score</div>
    <div class="dial">
      <svg viewBox="0 0 180 110" aria-hidden="true">
        <path d="M 20 100 A 70 70 0 0 1 160 100" class="track" />
        <path
          d="M 20 100 A 70 70 0 0 1 160 100"
          class="fill"
          :stroke-dasharray="dash"
        />
      </svg>
      <div class="num" data-mono>{{ clamped }}</div>
      <div class="of">/ 100</div>
    </div>
    <div class="label">{{ label }}</div>
  </section>
</template>

<style scoped>
.gauge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 1.1rem 1.2rem 1.25rem;
  border-radius: 6px;
  position: relative;
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.dial {
  position: relative;
  width: 180px;
  height: 110px;
  display: flex;
  justify-content: center;
}
svg { width: 100%; height: 100%; }
.track {
  fill: none;
  stroke: color-mix(in srgb, var(--paper-3) 22%, transparent);
  stroke-width: 12;
  stroke-linecap: round;
}
.fill {
  fill: none;
  stroke-width: 12;
  stroke-linecap: round;
  transition: stroke-dasharray 700ms cubic-bezier(0.22, 1, 0.36, 1);
}
.gauge[data-tone="up"]      .fill { stroke: var(--tape-up); }
.gauge[data-tone="down"]    .fill { stroke: var(--tape-down); }
.gauge[data-tone="caution"] .fill { stroke: var(--accent); }

.num {
  position: absolute;
  top: 38px;
  font-family: var(--font-mono);
  font-size: 2.2rem;
  letter-spacing: 0.04em;
  color: var(--paper-0);
  line-height: 1;
}
.of {
  position: absolute;
  top: 80px;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  color: var(--paper-3);
}
.label {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-2);
  margin-top: 0.35rem;
}
.gauge[data-tone="up"]      .label { color: var(--tape-up); }
.gauge[data-tone="down"]    .label { color: var(--tape-down); }
.gauge[data-tone="caution"] .label { color: var(--accent); }
</style>
