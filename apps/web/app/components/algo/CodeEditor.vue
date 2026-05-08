<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { Highlighter } from 'shiki'
import type { DiffPayload, Hunk, HunkDecision } from './diff-hunks'
import { resolveCode, summarise } from './diff-hunks'

/**
 * Editable Python code area with shiki syntax highlighting.
 *
 * Pattern: a transparent <textarea> sits on top of a shiki-rendered <pre>.
 * The textarea owns the caret + input; the pre owns the colours. We sync
 * scroll positions so they stay aligned as the user moves through the code.
 *
 * When `diff` is non-null we swap into a read-only review mode that shows
 * a unified diff with per-hunk ✓/✕ controls and a top toolbar
 * (Accept all / Discard all / Done — N of M applied). The toolbar emits
 * `done` with the resolved code and a {accepted,total} summary; the page
 * commits that resolved code into the draft and clears the diff prop,
 * which restores edit mode.
 *
 * Why not Monaco/CodeMirror: shiki + textarea is ~30 lines of glue and
 * pulls in a fraction of the bundle. We don't need IDE features.
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

// ---------------------------------------------------------------------------
// Diff-review mode
// ---------------------------------------------------------------------------

// Per-hunk decision state. Resets whenever a fresh diff payload arrives.
const decisions = ref<Map<string, HunkDecision>>(new Map())

watch(() => props.diff, () => {
  decisions.value = new Map()
  rerenderDiff()
}, { immediate: true })

const summary = computed(() => {
  if (!props.diff) return { accepted: 0, total: 0 }
  return summarise(props.diff.hunks, decisions.value)
})

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
    <!-- Edit mode -->
    <template v-if="!diff">
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
    </template>

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
