<script setup lang="ts">
import type { RiskPillar } from '../../../types/research'

defineProps<{ title: string, pillar: RiskPillar }>()
</script>

<template>
  <section class="pillar surface-1">
    <header class="head">
      <div class="eyebrow">{{ title }}</div>
      <div class="score" data-mono>{{ pillar.score }}<span class="of">/100</span></div>
    </header>
    <p class="rationale">{{ pillar.rationale }}</p>
    <div class="cards">
      <div
        v-for="(c, i) in pillar.cards"
        :key="i"
        class="card"
        :data-tone="c.tone"
      >
        <div class="card-head">
          <span class="dot" />
          <span class="card-label">{{ c.label }}</span>
        </div>
        <div class="card-value" data-mono>{{ c.value }}</div>
        <div class="card-note">{{ c.note }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.pillar {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 1.1rem 1.2rem 1.25rem;
  border-radius: 6px;
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-2);
}
.score {
  font-family: var(--font-mono);
  font-size: 1.4rem;
  color: var(--paper-0);
  letter-spacing: 0.04em;
}
.score .of {
  color: var(--paper-3);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  margin-left: 0.2rem;
}
.rationale {
  font-family: var(--font-sans);
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--paper-2);
}
.cards {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.25rem;
  border-top: 1px solid var(--ink-line);
}
.card {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  gap: 0.15rem 0.75rem;
  padding: 0.7rem 0.75rem;
  border: 1px solid var(--ink-line);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.18);
}
.card-head {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--paper-3);
  flex-shrink: 0;
}
.card[data-tone="beat"]    .dot { background: var(--tape-up); }
.card[data-tone="miss"]    .dot { background: var(--tape-down); }
.card[data-tone="caution"] .dot { background: var(--accent); }

.card-label {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-2);
}
.card-value {
  font-family: var(--font-mono);
  font-size: 0.95rem;
  color: var(--paper-0);
  text-align: right;
  letter-spacing: 0.02em;
}
.card[data-tone="beat"]    .card-value { color: var(--tape-up); }
.card[data-tone="miss"]    .card-value { color: var(--tape-down); }
.card[data-tone="caution"] .card-value { color: var(--accent); }

.card-note {
  grid-column: 1 / -1;
  font-family: var(--font-sans);
  font-size: 0.78rem;
  color: var(--paper-3);
  line-height: 1.4;
}
</style>
