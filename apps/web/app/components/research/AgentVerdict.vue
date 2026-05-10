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

const expanded = ref(true)

const tone = computed(() => {
  if (props.rating === 'strong-buy' || props.rating === 'buy') return 'up'
  if (props.rating === 'reduce' || props.rating === 'sell') return 'down'
  return 'neutral'
})

const ratingDisplay = computed(() => props.rating.replace(/-/g, ' '))
const clampedConfidence = computed(() => Math.max(0, Math.min(100, Math.round(props.confidence))))

// Conviction word: a single descriptor for the confidence band, kept short
// so it pairs typographically with the percentage. We don't need a 5-step
// adjective ladder — three is plenty and reads as a deliberate axis label.
const convictionWord = computed(() => {
  const c = clampedConfidence.value
  if (c >= 75) return 'high'
  if (c >= 50) return 'moderate'
  if (c >= 25) return 'tentative'
  return 'low'
})

// Confidence ring: SVG dasharray over a quarter-circle so it pairs visually
// with the rating chip without needing a full-circle gauge that screams
// "speedometer". Stroke length scales with confidence; offset tightens the
// reveal animation.
const RING_CIRCUMFERENCE = 2 * Math.PI * 32
const ringDash = computed(() => {
  const filled = (clampedConfidence.value / 100) * RING_CIRCUMFERENCE
  return `${filled} ${RING_CIRCUMFERENCE - filled}`
})
</script>

<template>
  <section class="verdict" :data-tone="tone" data-testid="agent-verdict">
    <header class="verdict__head">
      <span class="verdict__eyebrow">verdict transmitted</span>
      <span v-if="runId" class="verdict__runid" data-mono>
        run · {{ runId.slice(0, 8) }}
      </span>
    </header>

    <div class="verdict__hero">
      <!-- Rating slab: rating in big mono, conviction band underneath. -->
      <div class="verdict__rating-block">
        <span class="verdict__rating" data-mono>{{ ratingDisplay }}</span>
        <span class="verdict__conviction" data-mono>
          <span class="verdict__conviction-word">{{ convictionWord }}</span>
          conviction
        </span>
      </div>

      <!-- Confidence ring: quarter-arc that fills to the score. -->
      <div class="verdict__ring" data-testid="verdict-rating">
        <svg viewBox="0 0 80 80" width="80" height="80" aria-hidden="true">
          <circle
            class="verdict__ring-bg"
            cx="40" cy="40" r="32"
            fill="none"
            stroke-width="3"
            stroke-dasharray="2 4"
          />
          <circle
            class="verdict__ring-fg"
            cx="40" cy="40" r="32"
            fill="none"
            stroke-width="3"
            stroke-linecap="round"
            :stroke-dasharray="ringDash"
            stroke-dashoffset="0"
            transform="rotate(-90 40 40)"
          />
        </svg>
        <div class="verdict__ring-label">
          <span class="verdict__ring-value" data-mono>{{ clampedConfidence }}</span>
          <span class="verdict__ring-unit" data-mono>%</span>
        </div>
      </div>
    </div>

    <button
      type="button"
      class="verdict__toggle"
      :data-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span data-mono>{{ expanded ? 'collapse' : 'expand' }} rationale</span>
      <span class="verdict__toggle-glyph" data-mono>{{ expanded ? '−' : '+' }}</span>
    </button>

    <div v-if="expanded" class="verdict__rationale-wrap">
      <p class="verdict__rationale">{{ rationale }}</p>
    </div>

    <footer class="verdict__foot">
      <button type="button" class="verdict__action" disabled title="coming soon">
        <span data-mono>send to paper</span>
        <span class="verdict__action-aside" data-mono>v2</span>
      </button>
    </footer>
  </section>
</template>

<style scoped>
.verdict {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.4rem 1.5rem 1.2rem;
  background: var(--ink-1);
  border: 1px solid var(--ink-line-strong);
  border-radius: 4px;
  /* The verdict is the climactic moment — a thicker top border in the
     tone colour, plus a faint gradient wash from that colour into ink. */
  border-top: 3px solid var(--paper-3);
}
.verdict[data-tone="up"]      { border-top-color: var(--tape-up); }
.verdict[data-tone="down"]    { border-top-color: var(--tape-down); }
.verdict[data-tone="neutral"] { border-top-color: var(--accent); }
.verdict::before {
  /* Subtle wash at the top to extend the tone bar's energy into the card. */
  content: "";
  position: absolute;
  inset: 3px 0 auto 0;
  height: 60px;
  pointer-events: none;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, currentColor 8%, transparent) 0%,
    transparent 100%
  );
  border-radius: 0 0 0 0;
  opacity: 0.35;
}
.verdict[data-tone="up"]::before      { color: var(--tape-up); }
.verdict[data-tone="down"]::before    { color: var(--tape-down); }
.verdict[data-tone="neutral"]::before { color: var(--accent); }

.verdict__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
}
.verdict__eyebrow {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.verdict[data-tone="up"]      .verdict__eyebrow { color: var(--tape-up); }
.verdict[data-tone="down"]    .verdict__eyebrow { color: var(--tape-down); }
.verdict[data-tone="neutral"] .verdict__eyebrow { color: var(--accent); }

.verdict__runid {
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  color: var(--paper-3);
  text-transform: uppercase;
}

/* ─── Hero row: rating slab + confidence ring ─── */
.verdict__hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
  padding: 0.4rem 0 0.2rem;
}
.verdict__rating-block {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
}
.verdict__rating {
  font-size: 2.4rem;
  line-height: 1;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: 500;
  color: var(--paper-0);
  word-break: break-word;
}
.verdict[data-tone="up"]      .verdict__rating { color: var(--tape-up); }
.verdict[data-tone="down"]    .verdict__rating { color: var(--tape-down); }
.verdict[data-tone="neutral"] .verdict__rating { color: var(--accent); }

.verdict__conviction {
  font-size: 0.74rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.verdict__conviction-word {
  color: var(--paper-1);
  margin-right: 0.5rem;
  letter-spacing: 0.04em;
  text-transform: lowercase;
  font-style: italic;
}

.verdict__ring {
  position: relative;
  width: 80px;
  height: 80px;
  flex-shrink: 0;
}
.verdict__ring svg { display: block; }
.verdict__ring-bg { stroke: var(--ink-line-strong); }
.verdict__ring-fg {
  stroke: var(--paper-1);
  transition: stroke-dasharray 800ms cubic-bezier(0.22, 1, 0.36, 1);
}
.verdict[data-tone="up"]      .verdict__ring-fg { stroke: var(--tape-up); }
.verdict[data-tone="down"]    .verdict__ring-fg { stroke: var(--tape-down); }
.verdict[data-tone="neutral"] .verdict__ring-fg { stroke: var(--accent); }

.verdict__ring-label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 0.1rem;
}
.verdict__ring-value {
  font-size: 1.35rem;
  font-weight: 500;
  color: var(--paper-0);
  font-variant-numeric: tabular-nums;
}
.verdict__ring-unit {
  font-size: 0.7rem;
  color: var(--paper-3);
}

/* ─── Toggle + rationale ─── */
.verdict__toggle {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  background: transparent;
  border: 0;
  padding: 0.3rem 0;
  cursor: pointer;
}
.verdict__toggle:hover { color: var(--accent); }
.verdict__toggle-glyph {
  width: 1.1rem; height: 1.1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ink-line-strong);
  border-radius: 2px;
  font-size: 0.85rem;
  line-height: 1;
}

.verdict__rationale-wrap {
  border-left: 2px solid var(--ink-line-strong);
  padding-left: 1rem;
}
.verdict[data-tone="up"]      .verdict__rationale-wrap { border-left-color: color-mix(in srgb, var(--tape-up) 30%, transparent); }
.verdict[data-tone="down"]    .verdict__rationale-wrap { border-left-color: color-mix(in srgb, var(--tape-down) 30%, transparent); }
.verdict[data-tone="neutral"] .verdict__rationale-wrap { border-left-color: color-mix(in srgb, var(--accent) 30%, transparent); }

.verdict__rationale {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.65;
  color: var(--paper-1);
  max-width: 65ch;
  white-space: pre-wrap;
  /* Tight sibling-letter spacing for body to keep the editorial feel. */
  letter-spacing: 0.005em;
}

/* ─── Footer ─── */
.verdict__foot {
  display: flex;
  gap: 0.5rem;
  padding-top: 0.6rem;
  border-top: 1px solid var(--ink-line);
}
.verdict__action {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 0.45rem 0.9rem;
  border-radius: 3px;
  border: 1px solid var(--ink-line-strong);
  background: transparent;
  color: var(--paper-3);
  cursor: not-allowed;
  opacity: 0.7;
}
.verdict__action-aside {
  font-size: 0.6rem;
  color: var(--paper-3);
  letter-spacing: 0.22em;
  padding: 0.05rem 0.3rem;
  border: 1px solid var(--ink-line);
  border-radius: 2px;
  opacity: 0.7;
}
</style>
