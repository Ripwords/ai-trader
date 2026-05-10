<script setup lang="ts">
import { computed, ref } from 'vue'

interface RunHistoryRow {
  costUsd: number | null
}

interface Props {
  symbol: string
  runHistory: RunHistoryRow[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  start: [opts: { max_debate_rounds: number; deep_thinking: boolean }]
}>()

const debateRounds = ref(1)
const deepThinking = ref(true)

const estimate = computed(() => {
  const samples = props.runHistory
    .map(r => r.costUsd)
    .filter((v): v is number => typeof v === 'number')
  if (samples.length === 0) {
    return { kind: 'static' as const, low: 0.30, high: 1.50 }
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length
  const stdev = Math.sqrt(variance)
  return { kind: 'historical' as const, mean, stdev, n: samples.length }
})

const estimateText = computed(() => {
  if (estimate.value.kind === 'static') {
    return `$${estimate.value.low.toFixed(2)}–$${estimate.value.high.toFixed(2)} per run`
  }
  return `$${estimate.value.mean.toFixed(2)} ± $${estimate.value.stdev.toFixed(2)} (n=${estimate.value.n})`
})

function onStart() {
  emit('start', {
    max_debate_rounds: debateRounds.value,
    deep_thinking: deepThinking.value,
  })
}
</script>

<template>
  <section class="cost surface-1">
    <header class="head">
      <span class="eyebrow">run agents</span>
      <span class="symbol" data-mono>{{ symbol }}</span>
    </header>

    <div class="estimate" data-mono>
      est. cost · {{ estimateText }}
    </div>

    <div class="controls">
      <label class="ctrl">
        <span class="ctrl-label">debate rounds</span>
        <div class="slider-row">
          <input
            v-model.number="debateRounds"
            type="range"
            min="1"
            max="3"
            step="1"
            class="slider"
          />
          <span class="slider-val" data-mono>{{ debateRounds }}</span>
        </div>
      </label>

      <label class="ctrl checkbox">
        <input v-model="deepThinking" type="checkbox" />
        <span class="ctrl-label">deep thinking</span>
      </label>
    </div>

    <button type="button" class="run-btn" @click="onStart">
      run agents
    </button>
  </section>
</template>

<style scoped>
.cost {
  border-radius: 6px;
  padding: 1rem 1.2rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
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
.symbol {
  font-family: var(--font-mono);
  font-size: 0.9rem;
  color: var(--paper-1);
  letter-spacing: 0.06em;
}
.estimate {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-2);
  letter-spacing: 0.04em;
}
.controls {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.ctrl {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.ctrl.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 0.55rem;
}
.ctrl-label {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.slider-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.slider {
  flex: 1;
  accent-color: var(--accent);
}
.slider-val {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--paper-1);
  width: 1.5rem;
  text-align: right;
}
.run-btn {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 0.6rem 1.1rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  align-self: flex-start;
  transition: background-color 200ms ease;
}
.run-btn:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
</style>
