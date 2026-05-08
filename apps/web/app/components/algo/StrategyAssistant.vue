<script setup lang="ts">
import { DefaultChatTransport, isTextUIPart, type UIMessage } from 'ai'
import { Chat } from '@ai-sdk/vue'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { Highlighter } from 'shiki'
import { diffLines, type Change } from 'diff'

const props = defineProps<{
  currentCode: string
  symbol: string
  cadence: string
  /** Block key currently being reviewed in the editor; disables every
   *  other block's button while a review is in flight. */
  activeReviewKey: string | null
  /** Page tells us a review just resolved so we can flip the matching
   *  block's status to applied/discarded with its summary. */
  finishedReview: { blockKey: string, summary: { accepted: number; total: number } } | null
}>()

const emit = defineEmits<{
  // Kept for backward compatibility — the new flow routes through `review`
  // and the parent commits via the editor's done event. The page still
  // binds @apply for safety.
  (e: 'apply', code: string): void
  (e: 'review', blockKey: string, base: string, proposed: string): void
}>()

const input = ref('')

const chat = new Chat({
  transport: new DefaultChatTransport({
    api: '/api/algo/codegen',
    prepareSendMessagesRequest: ({ messages, body }) => ({
      body: {
        ...body,
        messages,
        currentCode: props.currentCode,
        symbol: props.symbol,
        cadence: props.cadence,
      },
    }),
  }),
  onError(err) { console.error('codegen error', err) },
})

function onSubmit() {
  const trimmed = input.value.trim()
  if (!trimmed) return
  chat.sendMessage({ text: trimmed })
  input.value = ''
}

function reset() {
  chat.messages = []
  blockState.value = new Map()
}

// --- Shiki highlighter (used inline per diff line) ----------------------

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
onMounted(ensureHighlighter)

// --- Per code-block state -----------------------------------------------

type BlockStatus = 'pending' | 'applied' | 'discarded'

interface BlockState {
  status: BlockStatus
  baseSnapshot: string  // currentCode at the moment the message arrived
  appliedAt?: string
  summary?: { accepted: number; total: number }
}

const blockState = ref<Map<string, BlockState>>(new Map())

function blockKey(messageId: string, blockIndex: number): string {
  return `${messageId}::${blockIndex}`
}

function getOrInitBlock(key: string): BlockState {
  const existing = blockState.value.get(key)
  if (existing) return existing
  const state: BlockState = { status: 'pending', baseSnapshot: props.currentCode }
  blockState.value.set(key, state)
  blockState.value = new Map(blockState.value)
  return state
}

function isStale(key: string): boolean {
  const s = blockState.value.get(key)
  if (!s || s.status !== 'pending') return false
  return s.baseSnapshot !== props.currentCode
}

function review(key: string, code: string) {
  const s = blockState.value.get(key)
  if (!s) return
  if (s.baseSnapshot !== props.currentCode) {
    const ok = window.confirm(
      'Your draft has changed since this suggestion was made. Reviewing will diff against the snapshot from when this message arrived. Continue?',
    )
    if (!ok) return
  }
  emit('review', key, s.baseSnapshot, code)
  // Status doesn't change yet — the page will tell us when review resolves
  // via the `finishedReview` prop, which the watcher below reacts to.
}

function statusPillText(s: BlockState): string {
  if (s.status === 'applied') {
    if (!s.summary) return '✓ applied'
    if (s.summary.accepted === 0) return '✕ discarded'
    if (s.summary.accepted === s.summary.total) return '✓ applied'
    return `✓ applied ${s.summary.accepted} of ${s.summary.total}`
  }
  return '✕ discarded'
}

watch(() => props.finishedReview, (fr) => {
  if (!fr) return
  const s = blockState.value.get(fr.blockKey)
  if (!s) return
  if (fr.summary.accepted === 0) {
    s.status = 'discarded'
  } else {
    s.status = 'applied'
    s.summary = fr.summary
    s.appliedAt = new Date().toISOString()
  }
  blockState.value = new Map(blockState.value)
})

// --- Diff rendering ------------------------------------------------------

interface DiffLine {
  kind: 'add' | 'remove' | 'context'
  html: string
}

function buildDiff(base: string, proposed: string, h: Highlighter): DiffLine[] {
  const changes: Change[] = diffLines(base, proposed)
  const out: DiffLine[] = []
  for (const c of changes) {
    const lines = c.value.replace(/\n$/, '').split('\n')
    const kind: DiffLine['kind'] = c.added ? 'add' : c.removed ? 'remove' : 'context'
    for (const line of lines) {
      const html = h.codeToHtml(line || ' ', {
        lang: 'python',
        theme: 'github-dark-default',
      })
      out.push({ kind, html })
    }
  }
  return out
}

interface ParsedBlock {
  kind: 'text' | 'code'
  text: string
  diff?: DiffLine[]
}

const renderedMessages = ref<Map<string, ParsedBlock[]>>(new Map())

function rawText(m: UIMessage): string {
  return m.parts.filter(isTextUIPart).map(p => p.text).join('')
}

function parseRaw(text: string): ParsedBlock[] {
  const out: ParsedBlock[] = []
  const re = /```(?:python|py)?\s*\n([\s\S]*?)```/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > lastIdx) {
      out.push({ kind: 'text', text: text.slice(lastIdx, m.index) })
    }
    out.push({ kind: 'code', text: m[1] ?? '' })
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length) {
    out.push({ kind: 'text', text: text.slice(lastIdx) })
  }
  return out
}

async function rerenderMessage(m: UIMessage) {
  const text = rawText(m)
  const blocks = parseRaw(text)
  const h = await ensureHighlighter()
  let codeIndex = 0
  for (const b of blocks) {
    if (b.kind === 'code') {
      const key = blockKey(m.id, codeIndex)
      const state = getOrInitBlock(key)
      b.diff = buildDiff(state.baseSnapshot, b.text, h)
      codeIndex++
    }
  }
  renderedMessages.value.set(m.id, blocks)
  renderedMessages.value = new Map(renderedMessages.value)
}

// Recompute diffs whenever a message's text changes (streaming).
watch(
  () => chat.messages.map(m => ({ id: m.id, role: m.role, text: rawText(m) })),
  (list) => {
    for (const m of list) {
      if (m.role === 'assistant') {
        const ref = chat.messages.find(x => x.id === m.id)
        if (ref) rerenderMessage(ref)
      }
    }
  },
  { deep: true },
)

// Helper for the template — get the per-code-block index when iterating.
function codeBlockIndex(blocks: ParsedBlock[], i: number): number {
  let n = 0
  for (let j = 0; j < i; j++) if (blocks[j]!.kind === 'code') n++
  return n
}

// Stable typed fallback for messages we haven't rendered yet (e.g. mid-stream
// before the first watch tick). Returning a `ParsedBlock[]` keeps the v-for
// element narrowing intact in the template.
function messageBlocks(m: UIMessage): ParsedBlock[] {
  const cached = renderedMessages.value.get(m.id)
  if (cached) return cached
  return [{ kind: 'text', text: rawText(m) }]
}
</script>

<template>
  <aside class="strategy-assistant flex flex-col h-full bg-[var(--ink-0)] border-l hairline">
    <div class="px-4 h-12 flex items-center justify-between border-b hairline shrink-0">
      <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
        strategy assistant
      </div>
      <button
        class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] hover:text-[var(--accent)]"
        @click="reset"
      >clear</button>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto scroll-hidden px-4 py-4 space-y-4">
      <div v-if="chat.messages.length === 0" class="text-center font-mono text-xs text-[var(--paper-3)] py-12 leading-relaxed">
        ask for a strategy<br/>
        <span class="text-[var(--paper-2)]">e.g. "20/50 SMA crossover" · "RSI mean-reversion" · "tighten my stops"</span>
      </div>

      <div v-for="m in chat.messages" :key="m.id" class="space-y-2">
        <div v-if="m.role === 'user'" class="flex justify-end">
          <div class="max-w-[90%] surface-1 px-3 py-2 text-sm text-[var(--paper-0)] whitespace-pre-wrap">
            {{ rawText(m) }}
          </div>
        </div>

        <div v-else-if="m.role === 'assistant'" class="space-y-2">
          <template v-for="(block, i) in messageBlocks(m)" :key="`${m.id}-${i}`">
            <div
              v-if="block.kind === 'text' && block.text.trim()"
              class="text-sm text-[var(--paper-1)] whitespace-pre-wrap leading-relaxed"
            >{{ block.text.trim() }}</div>

            <div v-else-if="block.kind === 'code'" class="space-y-1.5">
              <div class="rounded border border-[rgba(255,245,230,0.08)] overflow-hidden bg-[var(--ink-1)] text-xs leading-relaxed font-mono">
                <div
                  v-for="(line, li) in block.diff || []"
                  :key="li"
                  class="px-3 flex items-start"
                  :class="line.kind === 'add'
                    ? 'bg-[rgba(126,201,156,0.10)]'
                    : line.kind === 'remove'
                      ? 'bg-[rgba(224,122,95,0.10)]'
                      : ''"
                >
                  <span
                    class="select-none w-4 shrink-0"
                    :class="line.kind === 'add'
                      ? 'text-[var(--tape-up)]'
                      : line.kind === 'remove'
                        ? 'text-[var(--tape-down)]'
                        : 'text-[var(--paper-3)]'"
                  >{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }}</span>
                  <span class="flex-1 [&_pre.shiki]:!bg-transparent [&_pre.shiki]:m-0 [&_pre.shiki]:py-0 [&_pre.shiki]:px-0" v-html="line.html" />
                </div>
              </div>

              <div
                class="flex items-center gap-2"
                v-if="(blockState.get(blockKey(m.id, codeBlockIndex(renderedMessages.get(m.id) || [], i))) || { status: 'pending' }).status === 'pending'"
              >
                <button
                  class="font-mono text-xs uppercase tracking-wider px-3 py-1.5 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f] disabled:opacity-50 disabled:cursor-not-allowed"
                  :disabled="activeReviewKey !== null && activeReviewKey !== blockKey(m.id, codeBlockIndex(renderedMessages.get(m.id) || [], i))"
                  :title="activeReviewKey !== null && activeReviewKey !== blockKey(m.id, codeBlockIndex(renderedMessages.get(m.id) || [], i)) ? 'finish current review first' : ''"
                  @click="review(blockKey(m.id, codeBlockIndex(renderedMessages.get(m.id) || [], i)), block.text)"
                >→ review in editor</button>
                <span
                  v-if="activeReviewKey === blockKey(m.id, codeBlockIndex(renderedMessages.get(m.id) || [], i))"
                  class="font-mono text-xs text-[var(--accent)]"
                >reviewing…</span>
                <span
                  v-if="isStale(blockKey(m.id, codeBlockIndex(renderedMessages.get(m.id) || [], i)))"
                  class="font-mono text-xs text-[var(--paper-3)] italic"
                >(draft moved since)</span>
              </div>
              <div
                v-else
                class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]"
              >
                {{ statusPillText(blockState.get(blockKey(m.id, codeBlockIndex(renderedMessages.get(m.id) || [], i)))!) }}
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <form
      class="border-t hairline px-3 py-3 flex items-end gap-2"
      @submit.prevent="onSubmit"
    >
      <textarea
        v-model="input"
        rows="2"
        placeholder="describe a strategy or ask for changes…"
        class="flex-1 bg-[var(--ink-1)] border border-[rgba(255,245,230,0.08)] rounded px-3 py-2 text-sm text-[var(--paper-0)] focus:outline-none focus:border-[var(--accent)] resize-none"
        @keydown.enter.exact.prevent="onSubmit"
      />
      <button
        type="submit"
        :disabled="chat.status === 'streaming' || chat.status === 'submitted'"
        class="font-mono text-xs uppercase tracking-wider px-3 py-2 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f] disabled:opacity-60 self-stretch"
      >
        {{ chat.status === 'streaming' || chat.status === 'submitted' ? '…' : 'send' }}
      </button>
    </form>
  </aside>
</template>
