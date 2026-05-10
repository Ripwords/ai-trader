<script setup lang="ts">
import { computed } from 'vue'
import type { RiskSpeaker } from '../../../types/agents'
import MarkdownText from './MarkdownText.vue'

interface Turn {
  speaker: RiskSpeaker
  text: string
  turn: number
}

interface Props { turns: Turn[] }
const props = defineProps<Props>()

// Vertical stacked timeline rather than three side-by-side columns: the
// risk debate is a sequence of speeches, not a parallel argument. Order
// preserved by ``turn`` (the AgentState count) so a multi-round debate
// reads as alternating voices.
const ordered = computed(() =>
  [...props.turns].sort((a, b) => a.turn - b.turn),
)

const speakerLabel: Record<RiskSpeaker, string> = {
  aggressive:   'aggressive',
  conservative: 'conservative',
  neutral:      'neutral',
}

const speakerGlyph: Record<RiskSpeaker, string> = {
  aggressive:   '▲',
  conservative: '▼',
  neutral:      '·',
}
</script>

<template>
  <section
    v-if="ordered.length > 0"
    class="risk-debate"
    data-testid="risk-debate"
  >
    <header class="risk-debate__head">
      <span class="risk-debate__rule" aria-hidden="true">═</span>
      <span class="risk-debate__eyebrow">
        risk debate
        <span class="risk-debate__count" data-mono>· {{ ordered.length }} turns</span>
      </span>
      <span class="risk-debate__rule risk-debate__rule--right" aria-hidden="true">═</span>
    </header>

    <ol class="risk-debate__feed">
      <li
        v-for="t in ordered"
        :key="t.turn"
        class="risk-debate__turn"
        :data-speaker="t.speaker"
      >
        <header class="risk-debate__speaker">
          <span class="risk-debate__glyph" data-mono aria-hidden="true">{{ speakerGlyph[t.speaker] }}</span>
          <span class="risk-debate__name">{{ speakerLabel[t.speaker] }} analyst</span>
          <span class="risk-debate__turn-num" data-mono>turn {{ t.turn }}</span>
        </header>
        <MarkdownText :content="t.text" flush class="risk-debate__text" />
      </li>
    </ol>
  </section>
</template>

<style scoped>
.risk-debate {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: 1rem 0;
}

.risk-debate__head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.risk-debate__rule {
  flex: 1;
  color: var(--ink-line-strong);
  font-size: 0.7rem;
  white-space: nowrap;
  overflow: hidden;
}
.risk-debate__rule--right { text-align: right; }
.risk-debate__eyebrow {
  color: var(--accent);
}
.risk-debate__count {
  color: var(--paper-3);
  margin-left: 0.3rem;
}

.risk-debate__feed {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  /* Vertical timeline rule on the left, faint, so the three voices read
     as a single transcript thread rather than three independent boxes. */
  position: relative;
  padding-left: 1.1rem;
}
.risk-debate__feed::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.5rem;
  bottom: 0.5rem;
  width: 1px;
  background: linear-gradient(
    180deg,
    transparent 0%,
    var(--ink-line-strong) 8%,
    var(--ink-line-strong) 92%,
    transparent 100%
  );
}

.risk-debate__turn {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding-left: 0.8rem;
}
.risk-debate__turn::before {
  /* Speaker-coloured tick on the timeline rule. Squares for aggressive,
     hollow squares for conservative, dots for neutral — keeps the three
     visually distinct beyond colour for accessibility. */
  content: "";
  position: absolute;
  left: -0.45rem;
  top: 0.45rem;
  width: 8px;
  height: 8px;
  background: var(--paper-3);
  border-radius: 0;
}
.risk-debate__turn[data-speaker="aggressive"]::before {
  background: var(--tape-down);
}
.risk-debate__turn[data-speaker="conservative"]::before {
  background: transparent;
  border: 1px solid var(--tape-up);
  box-shadow: inset 0 0 0 1px var(--ink-0);
}
.risk-debate__turn[data-speaker="neutral"]::before {
  background: var(--accent);
  border-radius: 50%;
}

.risk-debate__speaker {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
.risk-debate__glyph { font-size: 0.85rem; }
.risk-debate__name { color: var(--paper-1); }
.risk-debate__turn[data-speaker="aggressive"]   .risk-debate__name,
.risk-debate__turn[data-speaker="aggressive"]   .risk-debate__glyph { color: var(--tape-down); }
.risk-debate__turn[data-speaker="conservative"] .risk-debate__name,
.risk-debate__turn[data-speaker="conservative"] .risk-debate__glyph { color: var(--tape-up); }
.risk-debate__turn[data-speaker="neutral"]      .risk-debate__name,
.risk-debate__turn[data-speaker="neutral"]      .risk-debate__glyph { color: var(--accent); }
.risk-debate__turn-num {
  margin-left: auto;
  color: var(--paper-3);
  font-size: 0.6rem;
  letter-spacing: 0.18em;
}

.risk-debate__text { max-width: 65ch; }
</style>
