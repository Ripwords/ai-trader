<script setup lang="ts">
import { computed } from 'vue'
import type { RiskRating } from '../../../types/research'

const props = defineProps<{ rating: RiskRating, bottomLine: string }>()

interface Stop { value: RiskRating, label: string }
const STOPS: Stop[] = [
  { value: 'sell',        label: 'sell' },
  { value: 'reduce',      label: 'reduce' },
  { value: 'hold',        label: 'hold' },
  { value: 'buy',         label: 'buy' },
  { value: 'strong-buy',  label: 'strong buy' },
]

const activeIdx = computed(() => STOPS.findIndex(s => s.value === props.rating))

const tone = computed(() => {
  switch (props.rating) {
    case 'strong-buy':
    case 'buy':
      return 'up'
    case 'sell':
    case 'reduce':
      return 'down'
    default:
      return 'neutral'
  }
})

function copyHtml() {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  // Snapshot the entire report subtree so the user can paste it elsewhere.
  const root = document.querySelector('[data-risk-report]')
  if (!root) return
  navigator.clipboard.writeText(root.outerHTML)
}
</script>

<template>
  <section class="bl surface-1" :data-tone="tone">
    <header>
      <div class="eyebrow">bottom line</div>
      <button type="button" class="copy" @click="copyHtml">copy html</button>
    </header>
    <p class="body">{{ bottomLine }}</p>
    <div class="rating-bar">
      <div
        v-for="(s, i) in STOPS"
        :key="s.value"
        class="stop"
        :data-active="i === activeIdx ? 'true' : 'false'"
        :data-side="i < 2 ? 'down' : i > 2 ? 'up' : 'neutral'"
      >
        <div class="tick" />
        <div class="label">{{ s.label }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bl {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 1.2rem 1.3rem 1.3rem;
  border-radius: 6px;
  position: relative;
}
.bl::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--paper-3);
  opacity: 0.35;
}
.bl[data-tone="up"]::before      { background: var(--tape-up);   opacity: 0.85; }
.bl[data-tone="down"]::before    { background: var(--tape-down); opacity: 0.85; }
.bl[data-tone="neutral"]::before { background: var(--accent);    opacity: 0.7; }

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--paper-2);
}
.copy {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--paper-3);
  border: 1px solid var(--ink-line-strong);
  background: transparent;
  padding: 0.45rem 0.75rem;
  border-radius: 4px;
  cursor: pointer;
  transition: color 160ms ease, border-color 160ms ease;
}
.copy:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.body {
  font-family: var(--font-sans);
  font-size: 0.95rem;
  line-height: 1.55;
  color: var(--paper-0);
}
.rating-bar {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 0;
  padding-top: 0.45rem;
  border-top: 1px solid var(--ink-line);
}
.stop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  padding-top: 0.4rem;
}
.tick {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--paper-3) 35%, transparent);
  border: 1px solid color-mix(in srgb, var(--paper-3) 60%, transparent);
  transition: background 200ms ease, transform 200ms ease, box-shadow 200ms ease;
}
.stop[data-active="true"] .tick {
  transform: scale(1.4);
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 60%, transparent);
}
.stop[data-active="true"][data-side="up"]   .tick { background: var(--tape-up); border-color: var(--tape-up); box-shadow: 0 0 14px color-mix(in srgb, var(--tape-up) 60%, transparent); }
.stop[data-active="true"][data-side="down"] .tick { background: var(--tape-down); border-color: var(--tape-down); box-shadow: 0 0 14px color-mix(in srgb, var(--tape-down) 60%, transparent); }
.label {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.stop[data-active="true"] .label { color: var(--paper-1); }
</style>
