<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { Highlighter } from 'shiki'

/**
 * Editable Python code area with shiki syntax highlighting.
 *
 * Pattern: a transparent <textarea> sits on top of a shiki-rendered <pre>.
 * The textarea owns the caret + input; the pre owns the colours. We sync
 * scroll positions so they stay aligned as the user moves through the code.
 *
 * Why not Monaco/CodeMirror: shiki + textarea is ~30 lines of glue and
 * pulls in a fraction of the bundle. We don't need IDE features.
 */
const props = defineProps<{
  modelValue: string
  rows?: number
  ariaLabel?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
}>()

const value = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
})

const taRef = ref<HTMLTextAreaElement | null>(null)
const preRef = ref<HTMLPreElement | null>(null)
const highlighter = shallowRef<Highlighter | null>(null)
const html = ref<string>('')

// shiki bundle: only python + a single dark theme so we don't pull every
// grammar into the client chunk.
async function ensureHighlighter() {
  if (highlighter.value) return highlighter.value
  const { createHighlighter } = await import('shiki')
  highlighter.value = await createHighlighter({
    themes: ['github-dark-default'],
    langs: ['python'],
  })
  return highlighter.value
}

async function rerender() {
  const h = await ensureHighlighter()
  html.value = h.codeToHtml(value.value || ' ', {
    lang: 'python',
    theme: 'github-dark-default',
  })
}

function syncScroll() {
  if (!taRef.value || !preRef.value) return
  preRef.value.scrollTop = taRef.value.scrollTop
  preRef.value.scrollLeft = taRef.value.scrollLeft
}

// Tab key inserts two spaces instead of jumping focus.
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.shiftKey) return
  e.preventDefault()
  const ta = taRef.value
  if (!ta) return
  const start = ta.selectionStart
  const end = ta.selectionEnd
  const next = `${value.value.slice(0, start)}    ${value.value.slice(end)}`
  value.value = next
  // place caret after the inserted spaces
  requestAnimationFrame(() => {
    ta.selectionStart = ta.selectionEnd = start + 4
  })
}

watch(value, rerender)
onMounted(rerender)
</script>

<template>
  <div class="code-editor relative font-mono text-sm leading-relaxed">
    <pre
      ref="preRef"
      aria-hidden="true"
      class="absolute inset-0 m-0 p-3 overflow-auto whitespace-pre rounded bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] pointer-events-none"
      v-html="html"
    />
    <textarea
      ref="taRef"
      v-model="value"
      :rows="rows ?? 18"
      :aria-label="ariaLabel"
      spellcheck="false"
      autocomplete="off"
      autocorrect="off"
      autocapitalize="off"
      class="relative block w-full p-3 rounded bg-transparent text-transparent caret-[var(--accent)] selection:bg-[var(--accent)]/30 border border-transparent focus:border-[var(--accent)] focus:outline-none whitespace-pre overflow-auto resize-y"
      @input="syncScroll"
      @scroll="syncScroll"
      @keydown="onKeydown"
    />
  </div>
</template>

<style scoped>
.code-editor :deep(pre.shiki) {
  background: transparent !important;
  margin: 0;
}
.code-editor :deep(pre.shiki code) {
  display: block;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}
.code-editor textarea {
  /* Match the shiki <pre> font metrics exactly so the overlay aligns. */
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  tab-size: 4;
}
</style>
