<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SynthesisStage } from '../../../types/agents'
import MarkdownText from './MarkdownText.vue'

interface Props {
  stage: SynthesisStage
  node: string
  content: string
}
const props = defineProps<Props>()

const expanded = ref(true)
function toggle() { expanded.value = !expanded.value }

const stageLabel: Record<SynthesisStage, string> = {
  'judge-decision':  'closing argument',
  'investment-plan': 'investment plan',
  'trader-plan':     'trader plan',
}

// Each synthesis stage has its own visual identity so the user can spot at
// a glance which intermediate artifact they're reading. ``judge-decision``
// is editorial commentary; ``investment-plan`` is structural; ``trader-plan``
// is action-oriented. Tones are kept restrained — the verdict card downstream
// is the only loud surface in the timeline.
const tone = computed<'plan' | 'trade' | 'verdict'>(() => {
  if (props.stage === 'investment-plan') return 'plan'
  if (props.stage === 'trader-plan')     return 'trade'
  return 'verdict'
})
</script>

<template>
  <article class="synth" :data-tone="tone" data-testid="synthesis-card">
    <header class="synth__head" @click="toggle">
      <span class="synth__rule" aria-hidden="true">┄</span>
      <span class="synth__eyebrow">
        <span class="synth__node">{{ node.toLowerCase() }}</span>
        <span class="synth__sep" aria-hidden="true">·</span>
        <span class="synth__stage">{{ stageLabel[stage] }}</span>
      </span>
      <span class="synth__chevron" data-mono :data-expanded="expanded">›</span>
    </header>

    <div v-if="expanded" class="synth__body">
      <MarkdownText :content="content" flush class="synth__text" />
    </div>
  </article>
</template>

<style scoped>
.synth {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0;
  /* Synthesis cards sit between the debate sections in the timeline.
     Their hairline rule makes them read as "step in the chain" rather
     than free-floating cards. */
}

.synth__head {
  display: flex;
  align-items: baseline;
  gap: 0.8rem;
  padding: 0.85rem 1.1rem;
  cursor: pointer;
  user-select: none;
  border-top: 1px solid var(--ink-line);
  border-bottom: 1px solid var(--ink-line);
  background: var(--ink-1);
  transition: background-color 140ms ease;
}
.synth__head:hover { background: rgba(255, 245, 230, 0.018); }

.synth__rule {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--paper-3);
  letter-spacing: 0;
}
.synth[data-tone="plan"]    .synth__rule { color: var(--accent); }
.synth[data-tone="trade"]   .synth__rule { color: var(--tape-up); }
.synth[data-tone="verdict"] .synth__rule { color: var(--paper-2); }

.synth__eyebrow {
  flex: 1;
  display: inline-flex;
  align-items: baseline;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.04em;
  text-transform: lowercase;
  color: var(--paper-1);
  flex-wrap: wrap;
}
.synth__node {
  color: var(--paper-0);
  font-weight: 500;
}
.synth__sep { color: var(--paper-3); }
.synth__stage {
  color: var(--paper-2);
  text-transform: uppercase;
  letter-spacing: 0.18em;
  font-size: 0.66rem;
  padding: 0.18rem 0.45rem;
  border-radius: 2px;
  border: 1px solid var(--ink-line);
}
.synth[data-tone="plan"]    .synth__stage { color: var(--accent);    border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
.synth[data-tone="trade"]   .synth__stage { color: var(--tape-up);   border-color: color-mix(in srgb, var(--tape-up) 35%, transparent); }
.synth[data-tone="verdict"] .synth__stage { color: var(--paper-1);   border-color: var(--ink-line-strong); }

.synth__chevron {
  font-size: 1rem;
  color: var(--paper-3);
  transition: transform 180ms ease;
  font-weight: 600;
}
.synth__chevron[data-expanded="true"] { transform: rotate(90deg); }

.synth__body {
  padding: 1rem 1.4rem 1.2rem;
  background: var(--ink-1);
}
.synth__text { max-width: 70ch; }
</style>
