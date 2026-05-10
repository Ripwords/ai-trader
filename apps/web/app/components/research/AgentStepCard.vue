<script setup lang="ts">
import { computed, ref } from 'vue'

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

const expanded = ref(false)

const stateGlyph = computed(() => {
  if (props.state === 'done') return '✓'
  if (props.state === 'failed') return '✗'
  return '•'
})

const tone = computed(() => {
  if (props.state === 'done') return 'up'
  if (props.state === 'failed') return 'down'
  return 'pending'
})

const label = computed(() => props.node.replace(/_/g, ' '))

function fmtArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args)
  } catch {
    return '{}'
  }
}
</script>

<template>
  <article
    class="step surface-1"
    :data-tone="tone"
    data-testid="agent-step-card"
  >
    <header class="head">
      <span class="glyph" data-mono>{{ stateGlyph }}</span>
      <span class="node">{{ label }}</span>
      <button
        v-if="toolCalls.length > 0"
        type="button"
        class="toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? '▼' : '▶' }} {{ toolCalls.length }} tool call{{ toolCalls.length === 1 ? '' : 's' }}
      </button>
    </header>

    <ul v-if="expanded && toolCalls.length > 0" class="tools">
      <li v-for="(tc, i) in toolCalls" :key="i" class="tool" :data-ok="tc.ok === false ? 'no' : tc.ok === true ? 'yes' : 'pending'">
        <div class="tool-head">
          <span class="tool-name" data-mono>{{ tc.tool }}</span>
          <span class="tool-state" data-mono>
            {{ tc.ok === undefined ? '…' : tc.ok ? 'ok' : 'fail' }}
          </span>
        </div>
        <pre class="args" data-mono>{{ fmtArgs(tc.args) }}</pre>
        <pre v-if="tc.preview" class="preview" data-mono>{{ tc.preview }}</pre>
      </li>
    </ul>

    <p v-if="summary" class="summary">{{ summary }}</p>
  </article>
</template>

<style scoped>
.step {
  border-radius: 6px;
  padding: 0.9rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  border-left: 2px solid var(--paper-3);
}
.step[data-tone="up"]      { border-left-color: var(--tape-up); }
.step[data-tone="down"]    { border-left-color: var(--tape-down); }
.step[data-tone="pending"] { border-left-color: var(--accent); }

.head {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}
.glyph {
  font-family: var(--font-mono);
  font-size: 0.95rem;
  color: var(--paper-2);
  width: 1.1rem;
  text-align: center;
}
.step[data-tone="up"]      .glyph { color: var(--tape-up); }
.step[data-tone="down"]    .glyph { color: var(--tape-down); }
.step[data-tone="pending"] .glyph { color: var(--accent); animation: pulse 1.4s ease-in-out infinite; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.node {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--paper-1);
  letter-spacing: 0.04em;
  flex: 1;
  text-transform: lowercase;
}
.toggle {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.16em;
  color: var(--paper-3);
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 0.2rem 0.4rem;
}
.toggle:hover { color: var(--accent); }

.tools {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.tool {
  border: 1px solid var(--ink-line);
  border-radius: 4px;
  padding: 0.55rem 0.7rem;
  background: var(--ink-2);
}
.tool-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}
.tool-name {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--paper-1);
}
.tool-state {
  font-family: var(--font-mono);
  font-size: 0.66rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--paper-3);
}
.tool[data-ok="yes"] .tool-state { color: var(--tape-up); }
.tool[data-ok="no"]  .tool-state { color: var(--tape-down); }

.args, .preview {
  margin: 0.4rem 0 0;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--paper-2);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}
.preview {
  color: var(--paper-3);
  border-top: 1px dashed var(--ink-line);
  padding-top: 0.4rem;
}
.summary {
  margin: 0;
  font-size: 0.85rem;
  color: var(--paper-1);
  line-height: 1.5;
}
</style>
