<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  valuation: number
  health: number
  growth: number
  total: number
}>()

interface Row {
  label: string
  score: number
  weight: number
  contribution: number
}

const rows = computed<Row[]>(() => [
  { label: 'valuation', score: props.valuation, weight: 0.35, contribution: props.valuation * 0.35 },
  { label: 'health',    score: props.health,    weight: 0.35, contribution: props.health    * 0.35 },
  { label: 'growth',    score: props.growth,    weight: 0.30, contribution: props.growth    * 0.30 },
])
</script>

<template>
  <section class="breakdown surface-1">
    <header class="head">
      <div class="eyebrow">score breakdown</div>
      <div class="weights" data-mono>35 · 35 · 30</div>
    </header>
    <div class="rows">
      <div
        v-for="r in rows"
        :key="r.label"
        class="row"
      >
        <div class="row-label">{{ r.label }}</div>
        <div class="row-bar">
          <div class="row-fill" :style="{ width: r.score + '%' }" />
          <div class="row-weight" :style="{ width: (r.weight * 100) + '%' }" />
        </div>
        <div class="row-score" data-mono>{{ r.score }}</div>
        <div class="row-contribution" data-mono>{{ r.contribution.toFixed(1) }}</div>
      </div>
    </div>
    <div class="total">
      <span class="eyebrow">blended risk score</span>
      <span class="total-num" data-mono>{{ total }}</span>
    </div>
  </section>
</template>

<style scoped>
.breakdown {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 1.1rem 1.2rem 1.2rem;
  border-radius: 6px;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.weights {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  color: var(--paper-3);
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.row {
  display: grid;
  grid-template-columns: 80px 1fr 32px 40px;
  align-items: center;
  gap: 0.8rem;
}
.row-label {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-2);
}
.row-bar {
  position: relative;
  height: 6px;
  background: color-mix(in srgb, var(--paper-3) 18%, transparent);
  border-radius: 999px;
  overflow: hidden;
}
.row-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--accent);
  transition: width 700ms cubic-bezier(0.22, 1, 0.36, 1);
}
.row-weight {
  position: absolute;
  inset: 0 auto 0 0;
  border-right: 1px dashed var(--paper-3);
  pointer-events: none;
  opacity: 0.55;
}
.row-score {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--paper-1);
  text-align: right;
}
.row-contribution {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--paper-3);
  text-align: right;
}
.total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-top: 0.65rem;
  border-top: 1px solid var(--ink-line);
}
.total-num {
  font-family: var(--font-mono);
  font-size: 1.6rem;
  letter-spacing: 0.04em;
  color: var(--accent);
}
</style>
