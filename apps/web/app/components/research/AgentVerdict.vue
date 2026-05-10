<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Rating } from '../../../types/agents'

interface Props {
  rating: Rating
  confidence: number
  rationale: string
  runId: string | null
}

const props = defineProps<Props>()

const expanded = ref(false)

const tone = computed(() => {
  if (props.rating === 'strong-buy' || props.rating === 'buy') return 'up'
  if (props.rating === 'reduce' || props.rating === 'sell') return 'down'
  return 'neutral'
})

const clampedConfidence = computed(() => Math.max(0, Math.min(100, Math.round(props.confidence))))
</script>

<template>
  <section class="verdict surface-1" :data-tone="tone" data-testid="agent-verdict">
    <header class="head">
      <span class="eyebrow">verdict</span>
      <span v-if="runId" class="run-id" data-mono>run {{ runId.slice(0, 8) }}</span>
    </header>

    <div class="body">
      <div class="rating-chip" :data-tone="tone">
        <span data-mono>{{ rating }}</span>
      </div>

      <div class="conf">
        <div class="conf-label">
          <span class="conf-eyebrow">confidence</span>
          <span class="conf-num" data-mono>{{ clampedConfidence }}%</span>
        </div>
        <div class="conf-bar">
          <div class="conf-fill" :style="{ width: clampedConfidence + '%' }" />
        </div>
      </div>
    </div>

    <button
      type="button"
      class="toggle"
      @click="expanded = !expanded"
    >
      {{ expanded ? '▼' : '▶' }} rationale
    </button>
    <p v-if="expanded" class="rationale">{{ rationale }}</p>

    <div class="actions">
      <button type="button" class="paper-btn" disabled title="coming soon">
        send to paper
      </button>
    </div>
  </section>
</template>

<style scoped>
.verdict {
  border-radius: 6px;
  padding: 1rem 1.2rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
  border-top: 2px solid var(--paper-3);
}
.verdict[data-tone="up"]      { border-top-color: var(--tape-up); }
.verdict[data-tone="down"]    { border-top-color: var(--tape-down); }
.verdict[data-tone="neutral"] { border-top-color: var(--accent); }

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
.run-id {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  color: var(--paper-3);
}
.body {
  display: flex;
  align-items: center;
  gap: 1.2rem;
  flex-wrap: wrap;
}
.rating-chip {
  font-family: var(--font-mono);
  font-size: 1.05rem;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  padding: 0.5rem 0.95rem;
  border-radius: 4px;
  border: 1px solid var(--ink-line);
  background: var(--ink-2);
}
.rating-chip[data-tone="up"]      { color: var(--tape-up); border-color: color-mix(in srgb, var(--tape-up) 35%, transparent); }
.rating-chip[data-tone="down"]    { color: var(--tape-down); border-color: color-mix(in srgb, var(--tape-down) 35%, transparent); }
.rating-chip[data-tone="neutral"] { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }

.conf {
  flex: 1;
  min-width: 200px;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.conf-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.conf-eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.conf-num {
  font-family: var(--font-mono);
  font-size: 0.95rem;
  color: var(--paper-0);
}
.conf-bar {
  height: 4px;
  background: var(--ink-2);
  border-radius: 2px;
  overflow: hidden;
}
.conf-fill {
  height: 100%;
  transition: width 700ms cubic-bezier(0.22, 1, 0.36, 1);
}
.verdict[data-tone="up"]      .conf-fill { background: var(--tape-up); }
.verdict[data-tone="down"]    .conf-fill { background: var(--tape-down); }
.verdict[data-tone="neutral"] .conf-fill { background: var(--accent); }

.toggle {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  background: transparent;
  border: 0;
  padding: 0.2rem 0;
  cursor: pointer;
  align-self: flex-start;
}
.toggle:hover { color: var(--accent); }
.rationale {
  margin: 0;
  font-size: 0.85rem;
  color: var(--paper-1);
  line-height: 1.55;
  white-space: pre-wrap;
}
.actions {
  display: flex;
  gap: 0.5rem;
}
.paper-btn {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 0.45rem 0.9rem;
  border-radius: 4px;
  border: 1px solid var(--ink-line);
  background: transparent;
  color: var(--paper-3);
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
