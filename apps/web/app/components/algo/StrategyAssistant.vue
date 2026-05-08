<script setup lang="ts">
import { DefaultChatTransport, isTextUIPart, type UIMessage } from 'ai'
import { Chat } from '@ai-sdk/vue'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { Highlighter } from 'shiki'

const props = defineProps<{
  currentCode: string
  symbol: string
  cadence: string
}>()

const emit = defineEmits<{
  (e: 'apply', code: string): void
}>()

const input = ref('')

// Local-only chat — these messages don't persist, mirroring how a side panel
// in an IDE gives you a scratch conversation per file.
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
}

// --- Shiki rendering for code blocks the assistant produces ---------------

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

interface RenderedBlock {
  kind: 'text' | 'code'
  text: string
  html?: string
}

const rendered = ref<Map<string, RenderedBlock[]>>(new Map())

/** Split a raw assistant response into text + python code segments. */
function parse(text: string): RenderedBlock[] {
  const out: RenderedBlock[] = []
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

async function rerenderMessage(id: string, raw: string) {
  const blocks = parse(raw)
  const h = await ensureHighlighter()
  for (const b of blocks) {
    if (b.kind === 'code') {
      b.html = h.codeToHtml(b.text || ' ', {
        lang: 'python',
        theme: 'github-dark-default',
      })
    }
  }
  rendered.value.set(id, blocks)
  // Trigger reactive update on the Map (Vue 3 doesn't deep-track Map mutations).
  rendered.value = new Map(rendered.value)
}

// Stitch a UIMessage's text parts back together — same model the main chat uses.
function rawText(m: UIMessage): string {
  return m.parts
    .filter(isTextUIPart)
    .map(p => p.text)
    .join('')
}

watch(
  () => chat.messages.map(m => ({ id: m.id, role: m.role, text: rawText(m) })),
  (list) => {
    for (const m of list) {
      if (m.role === 'assistant') rerenderMessage(m.id, m.text)
    }
  },
  { deep: true },
)

function apply(code: string) {
  emit('apply', code)
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
        <!-- User bubble -->
        <div v-if="m.role === 'user'" class="flex justify-end">
          <div class="max-w-[90%] surface-1 px-3 py-2 text-sm text-[var(--paper-0)] whitespace-pre-wrap">
            {{ rawText(m) }}
          </div>
        </div>

        <!-- Assistant bubble: parsed into text + code blocks -->
        <div v-else-if="m.role === 'assistant'" class="space-y-2">
          <template v-for="(block, i) in rendered.get(m.id) || [{ kind: 'text', text: rawText(m) }]" :key="`${m.id}-${i}`">
            <div
              v-if="block.kind === 'text' && block.text.trim()"
              class="text-sm text-[var(--paper-1)] whitespace-pre-wrap leading-relaxed"
            >{{ block.text.trim() }}</div>

            <div v-else-if="block.kind === 'code'" class="space-y-1">
              <div
                class="rounded border border-[rgba(255,245,230,0.08)] overflow-x-auto bg-[var(--ink-1)] text-xs leading-relaxed [&_pre.shiki]:!bg-transparent [&_pre.shiki]:m-0 [&_pre.shiki]:p-3"
                v-html="block.html"
              />
              <button
                class="font-mono text-xs uppercase tracking-wider px-3 py-1.5 bg-[var(--accent)] text-[#07080a] rounded hover:bg-[#b88a4f]"
                @click="apply(block.text)"
              >→ apply to editor</button>
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
