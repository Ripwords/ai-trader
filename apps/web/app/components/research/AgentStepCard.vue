<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MarkdownText from './MarkdownText.vue'

interface ToolCall {
  tool: string
  args: Record<string, unknown>
  ok?: boolean
  preview?: string
}

interface Props {
  node: string
  toolCalls: ToolCall[]
  summary: string | null
  state: 'running' | 'done' | 'failed'
}

const props = defineProps<Props>()

// Auto-expand while the node is mid-run (so the user can see tool activity
// as it lands), collapse to summary once done. Honours user override too:
// once they manually toggle, we stop auto-managing.
const userToggled = ref(false)
const expanded = ref(props.state === 'running')

watch(
  () => props.state,
  (s) => {
    if (userToggled.value) return
    expanded.value = s === 'running'
  },
)

function toggle() {
  userToggled.value = true
  expanded.value = !expanded.value
}

const stateGlyph = computed(() => {
  if (props.state === 'done') return '─'
  if (props.state === 'failed') return '×'
  return '◆'
})

const tone = computed(() => {
  if (props.state === 'done') return 'done'
  if (props.state === 'failed') return 'failed'
  return 'running'
})

const label = computed(() => props.node.replace(/_/g, ' '))

function fmtArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  return entries
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ')
}

function previewSnippet(s: string | undefined): string {
  if (!s) return ''
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 200) + '…' : flat
}
</script>

<template>
  <article
    class="step"
    :data-tone="tone"
    data-testid="agent-step-card"
  >
    <header class="step__head" @click="toggle">
      <span class="step__rule" aria-hidden="true">
        <span class="step__rule-glyph" data-mono>{{ stateGlyph }}</span>
      </span>
      <span class="step__node">{{ label }}</span>
      <span v-if="toolCalls.length > 0" class="step__count" data-mono>
        {{ toolCalls.length }} call{{ toolCalls.length === 1 ? '' : 's' }}
      </span>
      <span class="step__chevron" data-mono :data-expanded="expanded">›</span>
    </header>

    <div v-if="expanded" class="step__body">
      <ol v-if="toolCalls.length > 0" class="tools">
        <li
          v-for="(tc, i) in toolCalls"
          :key="i"
          class="tool"
          :data-state="tc.ok === false ? 'fail' : tc.ok === true ? 'ok' : 'pending'"
        >
          <div class="tool__bar">
            <span class="tool__index" data-mono>{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="tool__name" data-mono>{{ tc.tool }}</span>
            <span class="tool__sep" aria-hidden="true">·</span>
            <span class="tool__args" data-mono>{{ fmtArgs(tc.args) }}</span>
            <span class="tool__state" data-mono>
              <template v-if="tc.ok === undefined">…</template>
              <template v-else-if="tc.ok">ok</template>
              <template v-else>fail</template>
            </span>
          </div>
          <p
            v-if="tc.preview && tc.ok !== false"
            class="tool__preview"
            data-mono
          >{{ previewSnippet(tc.preview) }}</p>
          <p
            v-else-if="tc.preview && tc.ok === false"
            class="tool__error"
            data-mono
          >{{ previewSnippet(tc.preview) }}</p>
        </li>
      </ol>

      <MarkdownText
        v-if="summary"
        :content="summary"
        flush
        class="summary"
      />
    </div>
  </article>
</template>

<style scoped>
.step {
  display: grid;
  grid-template-columns: 1fr;
  position: relative;
  transition: opacity 200ms ease;
}
.step[data-tone="running"] {
  /* Active card has a faint amber wash + a heartbeat pulse on its left rule. */
  background: linear-gradient(90deg, rgba(212, 169, 106, 0.04) 0%, transparent 60%);
}
.step[data-tone="done"] { opacity: 0.78; }

.step__head {
  display: flex;
  align-items: baseline;
  gap: 0.85rem;
  padding: 0.85rem 1.1rem;
  cursor: pointer;
  user-select: none;
  border-top: 1px solid var(--ink-line);
}
.step__head:hover { background: rgba(255, 245, 230, 0.015); }

.step__rule {
  position: relative;
  display: inline-flex;
  width: 1.1rem;
  justify-content: center;
}
.step__rule-glyph {
  font-size: 0.95rem;
  color: var(--paper-2);
  line-height: 1;
}
.step[data-tone="running"] .step__rule-glyph {
  color: var(--accent);
  animation: heartbeat 1.6s ease-in-out infinite;
}
.step[data-tone="done"] .step__rule-glyph { color: var(--tape-up); }
.step[data-tone="failed"] .step__rule-glyph { color: var(--tape-down); }
@keyframes heartbeat {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.18); opacity: 0.7; }
}

.step__node {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 0.92rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: lowercase;
  color: var(--paper-1);
}
.step[data-tone="running"] .step__node { color: var(--paper-0); }

.step__count {
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  font-variant-numeric: tabular-nums;
}

.step__chevron {
  font-size: 1rem;
  color: var(--paper-3);
  transition: transform 180ms ease;
  font-weight: 600;
}
.step__chevron[data-expanded="true"] { transform: rotate(90deg); }

.step__body {
  padding: 0 1.1rem 1rem 2.95rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

/* ─── Tool list — terminal-style indented log ─── */
.tools {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.tool {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.45rem 0.6rem 0.45rem 0;
  border-left: 2px solid transparent;
  padding-left: 0.7rem;
}
.tool[data-state="pending"] { border-left-color: var(--accent); }
.tool[data-state="ok"]      { border-left-color: var(--ink-line-strong); }
.tool[data-state="fail"]    { border-left-color: var(--tape-down); }

.tool__bar {
  display: flex;
  align-items: baseline;
  gap: 0.55rem;
  flex-wrap: wrap;
  font-size: 0.74rem;
}
.tool__index {
  color: var(--paper-3);
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
}
.tool__name {
  color: var(--paper-0);
  font-weight: 500;
}
.tool__sep { color: var(--paper-3); }
.tool__args {
  color: var(--paper-2);
  font-size: 0.72rem;
  flex: 1;
  word-break: break-all;
}
.tool__state {
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
  margin-left: auto;
}
.tool[data-state="ok"]   .tool__state { color: var(--tape-up); }
.tool[data-state="fail"] .tool__state { color: var(--tape-down); }
.tool[data-state="pending"] .tool__state { color: var(--accent); }

.tool__preview {
  margin: 0 0 0 1.5rem;
  font-size: 0.72rem;
  color: var(--paper-3);
  line-height: 1.5;
  border-left: 1px dashed var(--ink-line);
  padding-left: 0.6rem;
}
.tool__error {
  margin: 0 0 0 1.5rem;
  font-size: 0.72rem;
  color: var(--tape-down);
  line-height: 1.5;
  border-left: 1px dashed var(--tape-down);
  padding-left: 0.6rem;
}

.summary {
  padding: 0.6rem 0.85rem;
  background: var(--ink-2);
  border-radius: 3px;
  border-left: 2px solid var(--accent-soft);
  max-width: 72ch;
  /* MarkdownText sets its own font sizes / colours; we only provide the
     surrounding card surface. */
}
</style>
