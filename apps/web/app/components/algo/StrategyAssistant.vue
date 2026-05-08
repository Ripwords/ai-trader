<script setup lang="ts">
import { DefaultChatTransport, getToolName, isReasoningUIPart, isTextUIPart, isToolUIPart, type UIMessage } from 'ai'
import { Chat } from '@ai-sdk/vue'
import { onMounted, ref, shallowRef, watch } from 'vue'
import type { Highlighter } from 'shiki'
import { isPartStreaming } from '@nuxt/ui/utils/ai'

interface ProposedConfig {
  initial_capital?: number
  commission_bps?: number
  slippage_bps?: number
  sizing_mode?: 'fixed_qty' | 'pct_equity' | 'fixed_cash'
  sizing_value?: number
  pyramiding_max?: number
}

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
  // The assistant has tooled up a backtest-config change. Page merges
  // the proposed fields into draft.* without saving — user clicks the
  // existing Save button (or Cmd+S) to persist.
  (e: 'apply-config', config: ProposedConfig): void
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
  toolPartState.value = new Map()
}

// --- Per-tool-call state (propose_config) -------------------------------

type ToolStatus = 'pending' | 'applied' | 'discarded'
const toolPartState = ref<Map<string, ToolStatus>>(new Map())

function toolKey(messageId: string, partIdx: number): string {
  return `${messageId}::tool::${partIdx}`
}

function toolStatus(key: string): ToolStatus {
  return toolPartState.value.get(key) ?? 'pending'
}

function setToolStatus(key: string, s: ToolStatus) {
  const next = new Map(toolPartState.value)
  next.set(key, s)
  toolPartState.value = next
}

function applyConfigProposal(key: string, config: ProposedConfig) {
  emit('apply-config', config)
  setToolStatus(key, 'applied')
}

function discardConfigProposal(key: string) {
  setToolStatus(key, 'discarded')
}

function fmtCfgValue(field: keyof ProposedConfig, v: unknown): string {
  if (v === undefined || v === null) return ''
  if (field === 'initial_capital') return `$${Number(v).toLocaleString()}`
  if (field === 'commission_bps' || field === 'slippage_bps') return `${v} bps`
  if (field === 'sizing_value') return String(v)
  return String(v)
}

function cfgFieldLabel(field: keyof ProposedConfig): string {
  switch (field) {
    case 'initial_capital': return 'capital'
    case 'commission_bps': return 'commission'
    case 'slippage_bps': return 'slippage'
    case 'sizing_mode': return 'sizing mode'
    case 'sizing_value': return 'sizing value'
    case 'pyramiding_max': return 'pyramiding max'
  }
}

function proposedConfigEntries(part: unknown): Array<[keyof ProposedConfig, unknown]> {
  const out = (part as { output?: { proposed?: ProposedConfig } })?.output?.proposed
  if (!out || typeof out !== 'object') return []
  const fields: (keyof ProposedConfig)[] = [
    'initial_capital', 'commission_bps', 'slippage_bps',
    'sizing_mode', 'sizing_value', 'pyramiding_max',
  ]
  return fields
    .filter(k => out[k] !== undefined && out[k] !== null)
    .map(k => [k, out[k]] as [keyof ProposedConfig, unknown])
}

// --- Shiki highlighter (used for the per-block clean preview) ----------

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
  autoFired?: boolean   // true once we've auto-triggered review for this block
  /** Cached shiki HTML for the proposed block. Re-computed when the raw
   *  code text changes (during streaming) so the v-html lookup stays sync. */
  previewHtml?: string
  /** Raw text the previewHtml was rendered from — guards against using a
   *  stale render after the streamed text grows. */
  previewSource?: string
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

// --- Text splitter -------------------------------------------------------
//
// Walks an assistant text part and yields prose chunks plus python fenced
// code blocks. `codeIndex` is the running count of code segments seen in
// THIS text (= within this message), which matches the convention used by
// `getOrInitBlock` so per-block state stays keyed consistently.

interface ProseSegment { kind: 'prose'; text: string }
interface CodeSegment { kind: 'code'; text: string; codeIndex: number }
type Segment = ProseSegment | CodeSegment

function splitText(text: string): Segment[] {
  const out: Segment[] = []
  const re = /```(?:python|py)?\s*\n([\s\S]*?)```/g
  let lastIdx = 0
  let codeIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > lastIdx) {
      out.push({ kind: 'prose', text: text.slice(lastIdx, m.index) })
    }
    out.push({ kind: 'code', text: m[1] ?? '', codeIndex })
    codeIndex++
    lastIdx = m.index + m[0].length
  }
  if (lastIdx < text.length) {
    out.push({ kind: 'prose', text: text.slice(lastIdx) })
  }
  return out
}

// Lookup helper for the template — returns the cached HTML for a block,
// or a plaintext-escaped fallback while shiki is still warming up. v-html
// must be sync, so all real rendering happens in `rerenderMessage`.
function codeHtmlFor(key: string, text: string): string {
  const s = blockState.value.get(key)
  if (s && s.previewHtml && s.previewSource === text) return s.previewHtml
  return `<pre class="shiki"><code>${escapeHtml(text)}</code></pre>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// --- Per-message rerender (highlight + auto-fire) -----------------------

function rawText(m: UIMessage): string {
  return m.parts.filter(isTextUIPart).map(p => p.text).join('')
}

async function rerenderMessage(m: UIMessage) {
  const segments = splitText(rawText(m))
  const h = await ensureHighlighter()
  // Auto-fire review for the FIRST eligible code block in this message.
  // We pick at most one because the activeReviewKey prop won't update until
  // the parent re-renders, so firing for multiple blocks in the same tick
  // would just race to overwrite each other in the page state.
  let toAutoFire: { key: string; code: string } | null = null
  let dirty = false
  for (const seg of segments) {
    if (seg.kind !== 'code') continue
    const key = blockKey(m.id, seg.codeIndex)
    const state = getOrInitBlock(key)
    if (state.previewSource !== seg.text) {
      state.previewHtml = h.codeToHtml(seg.text || ' ', {
        lang: 'python',
        theme: 'github-dark-default',
      })
      state.previewSource = seg.text
      dirty = true
    }
    if (
      !toAutoFire
      && !state.autoFired
      && state.status === 'pending'
      && props.activeReviewKey === null
    ) {
      state.autoFired = true
      toAutoFire = { key, code: seg.text }
      dirty = true
    }
  }
  if (dirty) blockState.value = new Map(blockState.value)
  if (toAutoFire) review(toAutoFire.key, toAutoFire.code)
}

// Recompute previews + auto-fire whenever a message's text changes (streaming).
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
</script>

<template>
  <aside class="strategy-assistant flex flex-col h-full bg-[var(--ink-0)] border-l hairline">
    <!-- Header -->
    <div class="px-4 h-12 flex items-center justify-between border-b hairline shrink-0">
      <div class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)]">
        strategy assistant
      </div>
      <button
        class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)] hover:text-[var(--accent)]"
        @click="reset"
      >clear</button>
    </div>

    <!-- Empty state -->
    <div
      v-if="chat.messages.length === 0"
      class="flex-1 flex items-center justify-center text-center font-mono text-xs text-[var(--paper-3)] py-12 leading-relaxed"
    >
      <div>
        ask for a strategy<br/>
        <span class="text-[var(--paper-2)]">e.g. "20/50 SMA crossover" · "RSI mean-reversion" · "tighten my stops"</span>
      </div>
    </div>

    <!-- Messages -->
    <UChatMessages
      v-else
      :messages="chat.messages"
      :status="chat.status"
      class="flex-1 min-h-0 px-4 overflow-y-auto scroll-hidden"
    >
      <template #content="{ message }">
        <template v-for="(part, idx) in message.parts" :key="`${message.id}-${idx}`">
          <!-- Reasoning (server-side support is optional; this is a no-op when absent) -->
          <UChatReasoning
            v-if="isReasoningUIPart(part)"
            :text="part.text"
            :streaming="isPartStreaming(part)"
          >
            <Comark
              :markdown="part.text"
              :streaming="isPartStreaming(part)"
              class="*:first:mt-0 *:last:mb-0"
            />
          </UChatReasoning>

          <!-- propose_config tool: render an Apply / Discard card.
               No auto-apply — config changes are user-confirmed. -->
          <template
            v-else-if="isToolUIPart(part) && getToolName(part) === 'propose_config'"
          >
            <div class="rounded border border-[var(--accent)] bg-[rgba(196,151,90,0.06)] p-3 space-y-2">
              <div class="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
                proposed backtest config
              </div>
              <ul class="font-mono text-xs space-y-1">
                <li
                  v-for="([field, value]) in proposedConfigEntries(part)"
                  :key="String(field)"
                  class="flex items-center justify-between gap-3"
                >
                  <span class="text-[var(--paper-3)] uppercase tracking-wider">{{ cfgFieldLabel(field) }}</span>
                  <span class="text-[var(--paper-0)]">{{ fmtCfgValue(field, value) }}</span>
                </li>
              </ul>
              <div
                v-if="toolStatus(toolKey(message.id, idx)) === 'pending'"
                class="flex items-center gap-2 pt-1"
              >
                <button
                  class="font-mono text-xs uppercase tracking-wider px-3 py-1.5 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f]"
                  @click="applyConfigProposal(
                    toolKey(message.id, idx),
                    (part as { output?: { proposed?: ProposedConfig } }).output?.proposed ?? {},
                  )"
                >✓ apply</button>
                <button
                  class="font-mono text-xs uppercase tracking-wider px-3 py-1.5 border border-[rgba(255,245,230,0.12)] text-[var(--paper-3)] rounded hover:text-[var(--paper-0)] hover:border-[var(--paper-2)]"
                  @click="discardConfigProposal(toolKey(message.id, idx))"
                >✕ discard</button>
              </div>
              <div
                v-else
                class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]"
              >
                {{ toolStatus(toolKey(message.id, idx)) === 'applied' ? '✓ applied — save to persist' : '✕ discarded' }}
              </div>
            </div>
          </template>

          <!-- Text part: assistant prose goes through Comark; python fenced
               code blocks get split out into shiki preview + review controls.
               User messages render verbatim. -->
          <template v-else-if="isTextUIPart(part)">
            <template v-if="message.role === 'assistant'">
              <template
                v-for="(seg, segIdx) in splitText(part.text)"
                :key="`${message.id}-${idx}-${segIdx}`"
              >
                <Comark
                  v-if="seg.kind === 'prose' && seg.text.trim()"
                  :markdown="seg.text"
                  :streaming="isPartStreaming(part)"
                  class="*:first:mt-0 *:last:mb-0 prose-invert"
                />
                <div v-else-if="seg.kind === 'code'" class="space-y-1.5">
                  <div
                    class="rounded border border-[rgba(255,245,230,0.08)] overflow-hidden bg-[var(--ink-1)] text-xs leading-relaxed font-mono [&_pre.shiki]:!bg-transparent [&_pre.shiki]:m-0 [&_pre.shiki]:p-3"
                    v-html="codeHtmlFor(blockKey(message.id, seg.codeIndex), seg.text)"
                  />
                  <!-- Block controls: review button + active pill + stale warning,
                       or status pill once a review has resolved. -->
                  <template
                    v-if="(blockState.get(blockKey(message.id, seg.codeIndex)) || { status: 'pending' }).status === 'pending'"
                  >
                    <div class="flex items-center gap-2">
                      <button
                        class="font-mono text-xs uppercase tracking-wider px-3 py-1.5 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f] disabled:opacity-50 disabled:cursor-not-allowed"
                        :disabled="activeReviewKey !== null && activeReviewKey !== blockKey(message.id, seg.codeIndex)"
                        :title="activeReviewKey !== null && activeReviewKey !== blockKey(message.id, seg.codeIndex) ? 'finish current review first' : ''"
                        @click="review(blockKey(message.id, seg.codeIndex), seg.text)"
                      >→ review in editor</button>
                      <span
                        v-if="activeReviewKey === blockKey(message.id, seg.codeIndex)"
                        class="font-mono text-xs text-[var(--accent)]"
                      >reviewing…</span>
                      <span
                        v-if="isStale(blockKey(message.id, seg.codeIndex))"
                        class="font-mono text-xs text-[var(--paper-3)] italic"
                      >(draft moved since)</span>
                    </div>
                  </template>
                  <div
                    v-else
                    class="font-mono text-xs uppercase tracking-wider text-[var(--paper-3)]"
                  >
                    {{ statusPillText(blockState.get(blockKey(message.id, seg.codeIndex))!) }}
                  </div>
                </div>
              </template>
            </template>
            <p
              v-else-if="message.role === 'user'"
              class="whitespace-pre-wrap text-base leading-[1.6] text-[var(--paper-0)]"
            >{{ part.text }}</p>
          </template>
        </template>
      </template>
    </UChatMessages>

    <!-- Composer -->
    <footer class="px-4 py-3 border-t hairline shrink-0">
      <UChatPrompt
        v-model="input"
        :error="chat.error"
        placeholder="describe a strategy or ask for changes…"
        :ui="{ body: '!pe-11' }"
        @submit="onSubmit"
      >
        <UChatPromptSubmit
          :status="chat.status"
          color="neutral"
          variant="solid"
          :ui="{
            base: '!absolute !bottom-0 !end-0 !size-8 !p-0 !rounded-md !bg-[#d4a96a] hover:!bg-[#b88a4f] !text-[#07080a] !inline-flex !items-center !justify-center',
            leadingIcon: '!size-4',
            trailingIcon: '!size-4',
          }"
          @stop="chat.stop()"
          @reload="chat.regenerate()"
        />
      </UChatPrompt>
    </footer>
  </aside>
</template>
