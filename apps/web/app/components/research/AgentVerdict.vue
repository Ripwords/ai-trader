<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Rating } from '../../../types/agents'
import { parseVerdictReport } from '../../lib/verdictReport'
import MarkdownText from './MarkdownText.vue'

interface Props {
  rating: Rating
  // null when the model gave no confidence number — we show a qualitative
  // state rather than fabricating a percentage.
  confidence: number | null
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

// The model is not prompted for a confidence number, so it's frequently
// absent. When present we render the ring + band; when null we say so plainly
// instead of anchoring on a meaningless 50%.
const hasConfidence = computed(() => props.confidence !== null)
const clampedConfidence = computed(() =>
  Math.max(0, Math.min(100, Math.round(props.confidence ?? 0))),
)

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

// Structured report: split the rationale into titled sections so the verdict
// reads like a research note rather than one undifferentiated block.
const sections = computed(() => parseVerdictReport(props.rationale))

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
        <span v-if="hasConfidence" class="verdict__conviction" data-mono>
          <span class="verdict__conviction-word">{{ convictionWord }}</span>
          conviction
        </span>
        <span v-else class="verdict__conviction verdict__conviction--unstated" data-mono>
          conviction unstated
        </span>
      </div>

      <!-- Confidence ring: quarter-arc that fills to the score. Only shown
           when the model actually reported a number. -->
      <div v-if="hasConfidence" class="verdict__ring" data-testid="verdict-rating">
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

    <div v-if="expanded" class="verdict__report">
      <article
        v-for="(section, i) in sections"
        :key="i"
        class="verdict__section"
        :class="{ 'verdict__section--titled': section.title }"
      >
        <h3 v-if="section.title" class="verdict__section-title" data-mono>
          {{ section.title }}
        </h3>
        <MarkdownText :content="section.body" flush class="verdict__section-body" />
      </article>
    </div>
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
.verdict__conviction--unstated {
  color: var(--paper-3);
  font-style: italic;
  text-transform: lowercase;
  letter-spacing: 0.04em;
  opacity: 0.85;
}

.verdict__ring {
  position: relative;
  width: 96px;
  height: 96px;
  flex-shrink: 0;
}
.verdict__ring svg {
  display: block;
  width: 100%;
  height: 100%;
}
.verdict__ring-bg { stroke: var(--ink-line-strong); }
.verdict__ring-fg {
  stroke: var(--paper-1);
  transition: stroke-dasharray 800ms cubic-bezier(0.22, 1, 0.36, 1);
}
.verdict[data-tone="up"]      .verdict__ring-fg { stroke: var(--tape-up); }
.verdict[data-tone="down"]    .verdict__ring-fg { stroke: var(--tape-down); }
.verdict[data-tone="neutral"] .verdict__ring-fg { stroke: var(--accent); }

.verdict__ring-label {
  /* Sit in the geometric centre of the ring. ``align-items: baseline``
     was forcing the text up because the value and unit have different
     font sizes — baseline alignment shoves the line-box around. Use
     centered alignment with explicit baseline coupling on the children
     instead so the ``50`` and ``%`` still share a typographic baseline
     but the whole label is vertically centred in the ring. */
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.05rem;
  pointer-events: none;
}
.verdict__ring-value {
  font-size: 1.35rem;
  font-weight: 500;
  line-height: 1;
  color: var(--paper-0);
  font-variant-numeric: tabular-nums;
}
.verdict__ring-unit {
  font-size: 0.65rem;
  line-height: 1;
  color: var(--paper-3);
  /* Nudge the ``%`` so it baselines with the digits instead of sitting
     centred on the line-box, which always reads "above" next to a
     larger character. */
  align-self: flex-end;
  padding-bottom: 0.18rem;
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

/* ─── Structured report: one block per parsed section ─── */
.verdict__report {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}
.verdict__section {
  border-left: 2px solid var(--ink-line-strong);
  padding-left: 1rem;
}
.verdict[data-tone="up"]      .verdict__section { border-left-color: color-mix(in srgb, var(--tape-up) 30%, transparent); }
.verdict[data-tone="down"]    .verdict__section { border-left-color: color-mix(in srgb, var(--tape-down) 30%, transparent); }
.verdict[data-tone="neutral"] .verdict__section { border-left-color: color-mix(in srgb, var(--accent) 30%, transparent); }

/* Section heading: small-caps mono eyebrow above the body, accented per tone
   so the report scans like a wire-service note. */
.verdict__section-title {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--paper-2);
  margin: 0 0 0.55rem;
}
.verdict[data-tone="up"]      .verdict__section-title { color: var(--tape-up); }
.verdict[data-tone="down"]    .verdict__section-title { color: var(--tape-down); }
.verdict[data-tone="neutral"] .verdict__section-title { color: var(--accent); }

/* MarkdownText supplies its own prose styling; no overrides needed here. */
</style>
