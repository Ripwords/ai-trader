<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { Highlighter } from 'shiki'
import type { DiffPayload, Hunk, HunkDecision } from './diff-hunks'
import { resolveCode, summarise } from './diff-hunks'

import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  indentUnit,
  foldGutter,
  foldKeymap,
} from '@codemirror/language'
import { python } from '@codemirror/lang-python'

/**
 * Editable Python code area.
 *
 * Edit mode is a CodeMirror 6 EditorView with @codemirror/lang-python — gives
 * us auto-indent on Enter (Python-aware), native cmd+Z / cmd+shift+Z, bracket
 * matching, multi-line indent/dedent on Tab, and search via cmd+F. The host
 * page's draft state binds via v-model in the usual way.
 *
 * When `diff` is non-null we hide the editor and render the unified-diff
 * review surface instead — read-only by construction, with per-hunk ✓/✕
 * controls and a top toolbar (Accept all / Discard all / Done — N of M
 * applied). The toolbar emits `done` with the resolved code; the page
 * commits it into the draft and clears `diff`, restoring edit mode.
 */
const props = defineProps<{
  modelValue: string
  rows?: number
  ariaLabel?: string
  diff?: DiffPayload | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'done', resolved: string, summary: { accepted: number; total: number }): void
}>()

// ---------------------------------------------------------------------------
// Edit mode — CodeMirror 6
// ---------------------------------------------------------------------------

const editorEl = ref<HTMLDivElement | null>(null)
let view: EditorView | undefined

// True while we're applying an external prop change to the editor doc, so
// the update listener doesn't echo a synthetic update:modelValue back up.
let applyingExternalChange = false

function buildExtensions(): Extension[] {
  return [
    lineNumbers(),
    foldGutter(),
    drawSelection(),
    highlightActiveLine(),
    history(),
    indentOnInput(),
    indentUnit.of('    '),
    bracketMatching(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    python(),
    keymap.of([
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
    ]),
    EditorView.theme({
      '&': {
        backgroundColor: 'var(--ink-1)',
        color: 'var(--paper-0)',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: '13px',
        borderRadius: '6px',
        border: '1px solid rgba(255, 245, 230, 0.08)',
      },
      '&.cm-focused': {
        outline: 'none',
        borderColor: 'var(--accent)',
      },
      '.cm-content': {
        padding: '12px 0',
        caretColor: 'var(--accent)',
      },
      '.cm-cursor': {
        borderLeftColor: 'var(--accent)',
      },
      '.cm-line': {
        padding: '0 12px',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: '#6f6c63',
        border: 'none',
      },
      '.cm-activeLineGutter, .cm-activeLine': {
        backgroundColor: 'rgba(212, 169, 106, 0.04)',
      },
      '.cm-selectionBackground, ::selection': {
        backgroundColor: 'rgba(212, 169, 106, 0.25)',
      },
      '&.cm-focused .cm-selectionBackground': {
        backgroundColor: 'rgba(212, 169, 106, 0.30)',
      },
      '.cm-matchingBracket': {
        backgroundColor: 'rgba(212, 169, 106, 0.20)',
        outline: '1px solid var(--accent)',
      },
      '.cm-scroller': {
        fontFamily: 'inherit',
        lineHeight: '1.55',
      },
    }, { dark: true }),
    EditorView.updateListener.of((u) => {
      if (!u.docChanged || applyingExternalChange) return
      emit('update:modelValue', u.state.doc.toString())
    }),
  ]
}

function mountEditor() {
  if (!editorEl.value || view) return
  view = new EditorView({
    parent: editorEl.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: buildExtensions(),
    }),
  })
  // Best-effort min-height matched to the rows prop.
  const lineHeight = 20.15  // 13px * 1.55
  const minH = (props.rows ?? 18) * lineHeight + 24  // padding above + below
  ;(editorEl.value as HTMLDivElement).style.minHeight = `${Math.round(minH)}px`
}

function unmountEditor() {
  view?.destroy()
  view = undefined
}

// Sync prop changes (e.g. `draft.code = resolved` after a diff Apply) into
// the editor doc, without emitting another update.
watch(() => props.modelValue, (next) => {
  if (!view) return
  const cur = view.state.doc.toString()
  if (cur === next) return
  applyingExternalChange = true
  view.dispatch({
    changes: { from: 0, to: cur.length, insert: next },
  })
  applyingExternalChange = false
})

// Mount/unmount when toggling between edit and diff modes. Vue re-renders
// the template branch, so the ref drops to null before swapping back.
watch(() => props.diff, (next) => {
  if (next) {
    unmountEditor()
  } else {
    // Wait for the v-if to render the edit-mode div before mounting.
    requestAnimationFrame(() => mountEditor())
  }
}, { immediate: false })

onMounted(() => {
  if (!props.diff) mountEditor()
  if (!highlighter.value) ensureHighlighter()
})

onUnmounted(() => unmountEditor())

// ---------------------------------------------------------------------------
// Diff-review mode — shiki-rendered unified diff with per-hunk controls
// ---------------------------------------------------------------------------

const highlighter = shallowRef<Highlighter | null>(null)

async function ensureHighlighter() {
  if (highlighter.value) return highlighter.value
  const { createHighlighter } = await import('shiki')
  highlighter.value = await createHighlighter({
    themes: ['github-dark-default'],
    langs: ['python'],
  })
  return highlighter.value
}

// Per-hunk decision state. Resets whenever a fresh diff payload arrives.
const decisions = ref<Map<string, HunkDecision>>(new Map())

watch(() => props.diff, () => {
  decisions.value = new Map()
  rerenderDiff()
}, { immediate: true })

const summary = ref<{ accepted: number; total: number }>({ accepted: 0, total: 0 })
watch([() => props.diff, decisions], () => {
  summary.value = props.diff
    ? summarise(props.diff.hunks, decisions.value)
    : { accepted: 0, total: 0 }
}, { immediate: true })

// Pre-rendered shiki HTML keyed by line content. We only highlight unique
// line strings once per diff to keep this snappy on big patches.
const highlightedLines = ref<Map<string, string>>(new Map())

async function rerenderDiff() {
  if (!props.diff) {
    highlightedLines.value = new Map()
    return
  }
  const h = await ensureHighlighter()
  const seen = new Set<string>()
  for (const hk of props.diff.hunks) {
    for (const ln of hk.contextBefore) seen.add(ln)
    for (const ln of hk.baseLines) seen.add(ln)
    for (const ln of hk.proposedLines) seen.add(ln)
    for (const ln of hk.contextAfter) seen.add(ln)
  }
  const next = new Map<string, string>()
  for (const ln of seen) {
    next.set(ln, h.codeToHtml(ln || ' ', {
      lang: 'python',
      theme: 'github-dark-default',
    }))
  }
  highlightedLines.value = next
}

function lineHtml(line: string): string {
  return highlightedLines.value.get(line) ?? escapeHtml(line)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function decisionFor(id: string): HunkDecision {
  return decisions.value.get(id) ?? 'pending'
}

function setDecision(id: string, d: HunkDecision) {
  const next = new Map(decisions.value)
  next.set(id, d)
  decisions.value = next
}

function acceptHunk(h: Hunk) {
  setDecision(h.id, decisionFor(h.id) === 'accepted' ? 'pending' : 'accepted')
}

function rejectHunk(h: Hunk) {
  setDecision(h.id, decisionFor(h.id) === 'rejected' ? 'pending' : 'rejected')
}

function acceptAll() {
  if (!props.diff) return
  const next = new Map<string, HunkDecision>()
  for (const h of props.diff.hunks) next.set(h.id, 'accepted')
  decisions.value = next
  emitDone()
}

function discardAll() {
  if (!props.diff) return
  const next = new Map<string, HunkDecision>()
  for (const h of props.diff.hunks) next.set(h.id, 'rejected')
  decisions.value = next
  emitDone()
}

function done() {
  emitDone()
}

function emitDone() {
  if (!props.diff) return
  const resolved = resolveCode(props.diff.base, props.diff.hunks, decisions.value)
  const sum = summarise(props.diff.hunks, decisions.value)
  emit('done', resolved, sum)
}
</script>

<template>
  <div class="code-editor relative font-mono text-sm leading-relaxed">
    <!-- Edit mode: CodeMirror -->
    <div
      v-if="!diff"
      ref="editorEl"
      :aria-label="ariaLabel"
      class="cm-host w-full"
    />

    <!-- Diff-review mode -->
    <div
      v-else
      class="rounded bg-[var(--ink-1)] border border-[var(--accent)] overflow-hidden"
      role="region"
      aria-label="diff review"
    >
      <!-- Toolbar -->
      <div class="flex items-center gap-2 px-3 py-2 border-b border-[rgba(255,245,230,0.08)] bg-[rgba(196,151,90,0.06)]">
        <span class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
          review mode
        </span>
        <span class="font-mono text-xs text-[var(--paper-3)]">·</span>
        <span class="font-mono text-xs text-[var(--paper-2)]">
          {{ diff.hunks.length }} {{ diff.hunks.length === 1 ? 'hunk' : 'hunks' }}
        </span>
        <div class="flex-1" />
        <button
          type="button"
          class="font-mono text-xs uppercase tracking-wider px-3 py-1.5 border border-[var(--tape-up)] text-[var(--tape-up)] rounded hover:bg-[var(--tape-up)] hover:text-[#07080a]"
          @click="acceptAll"
        >✓ accept all</button>
        <button
          type="button"
          class="font-mono text-xs uppercase tracking-wider px-3 py-1.5 border border-[var(--tape-down)] text-[var(--tape-down)] rounded hover:bg-[var(--tape-down)] hover:text-[#07080a]"
          @click="discardAll"
        >✕ discard all</button>
        <button
          type="button"
          class="font-mono text-xs uppercase tracking-wider px-3 py-1.5 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f]"
          @click="done"
        >✓ done — {{ summary.accepted }} of {{ summary.total }} applied</button>
      </div>

      <!-- Hunks -->
      <div class="text-xs leading-relaxed font-mono max-h-[60vh] overflow-auto">
        <div v-if="diff.hunks.length === 0" class="px-3 py-6 text-center text-[var(--paper-3)]">
          no changes
        </div>
        <div
          v-for="(h, hi) in diff.hunks"
          :key="h.id"
          class="border-t border-[rgba(255,245,230,0.06)] first:border-t-0"
          :class="decisionFor(h.id) === 'accepted'
            ? 'border-l-2 border-l-[var(--tape-up)] bg-[rgba(126,201,156,0.04)]'
            : decisionFor(h.id) === 'rejected'
              ? 'border-l-2 border-l-[var(--tape-down)] opacity-50'
              : ''"
        >
          <!-- Context before -->
          <div
            v-for="(ln, ci) in h.contextBefore"
            :key="`${h.id}-cb-${ci}`"
            class="px-3 flex items-start"
          >
            <span class="select-none w-4 shrink-0 text-[var(--paper-3)]"> </span>
            <span
              class="flex-1 [&_pre.shiki]:!bg-transparent [&_pre.shiki]:m-0 [&_pre.shiki]:py-0 [&_pre.shiki]:px-0"
              v-html="lineHtml(ln)"
            />
          </div>

          <!-- Hunk header bar with per-hunk controls -->
          <div class="px-3 py-1 flex items-center gap-2 border-y border-[rgba(255,245,230,0.06)] bg-[rgba(255,245,230,0.02)]">
            <span class="font-mono text-[10px] uppercase tracking-wider text-[var(--paper-3)]">
              hunk {{ hi + 1 }}
            </span>
            <span class="font-mono text-[10px] text-[var(--paper-3)]">
              −{{ h.baseLines.length }} +{{ h.proposedLines.length }}
            </span>
            <div class="flex-1" />
            <button
              type="button"
              :aria-label="`accept hunk ${hi + 1}`"
              class="font-mono text-xs px-2 py-0.5 rounded border transition-colors"
              :class="decisionFor(h.id) === 'accepted'
                ? 'bg-[var(--tape-up)] text-[#07080a] border-[var(--tape-up)]'
                : 'border-[rgba(255,245,230,0.12)] text-[var(--tape-up)] hover:border-[var(--tape-up)]'"
              @click="acceptHunk(h)"
            >✓</button>
            <button
              type="button"
              :aria-label="`reject hunk ${hi + 1}`"
              class="font-mono text-xs px-2 py-0.5 rounded border transition-colors"
              :class="decisionFor(h.id) === 'rejected'
                ? 'bg-[var(--tape-down)] text-[#07080a] border-[var(--tape-down)]'
                : 'border-[rgba(255,245,230,0.12)] text-[var(--tape-down)] hover:border-[var(--tape-down)]'"
              @click="rejectHunk(h)"
            >✕</button>
          </div>

          <!-- Removed lines -->
          <div
            v-for="(ln, ri) in h.baseLines"
            :key="`${h.id}-r-${ri}`"
            class="px-3 flex items-start bg-[rgba(224,122,95,0.10)]"
            :class="decisionFor(h.id) === 'rejected' ? 'line-through opacity-80' : ''"
          >
            <span class="select-none w-4 shrink-0 text-[var(--tape-down)]">-</span>
            <span
              class="flex-1 [&_pre.shiki]:!bg-transparent [&_pre.shiki]:m-0 [&_pre.shiki]:py-0 [&_pre.shiki]:px-0"
              v-html="lineHtml(ln)"
            />
          </div>

          <!-- Added lines -->
          <div
            v-for="(ln, ai) in h.proposedLines"
            :key="`${h.id}-a-${ai}`"
            class="px-3 flex items-start bg-[rgba(126,201,156,0.10)]"
            :class="decisionFor(h.id) === 'rejected' ? 'line-through opacity-80' : ''"
          >
            <span class="select-none w-4 shrink-0 text-[var(--tape-up)]">+</span>
            <span
              class="flex-1 [&_pre.shiki]:!bg-transparent [&_pre.shiki]:m-0 [&_pre.shiki]:py-0 [&_pre.shiki]:px-0"
              v-html="lineHtml(ln)"
            />
          </div>

          <!-- Context after -->
          <div
            v-for="(ln, ci) in h.contextAfter"
            :key="`${h.id}-ca-${ci}`"
            class="px-3 flex items-start"
          >
            <span class="select-none w-4 shrink-0 text-[var(--paper-3)]"> </span>
            <span
              class="flex-1 [&_pre.shiki]:!bg-transparent [&_pre.shiki]:m-0 [&_pre.shiki]:py-0 [&_pre.shiki]:px-0"
              v-html="lineHtml(ln)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.code-editor :deep(.cm-editor) {
  height: auto;
}
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
</style>
