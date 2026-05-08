<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

type StreamChunk =
  | { type: 'text-delta'; payload: { text: string } }
  | { type: 'tool-call'; payload: { toolCallId: string; toolName: string; args?: unknown } }
  | { type: 'tool-result'; payload: { toolCallId: string; toolName: string; result?: unknown } }
  | { type: 'finish'; payload: { finishReason: string | null } }
  | { type: 'error'; payload: { message: string } }

interface KLineResult {
  code: string
  ktype: string
  bars: { time: string; open: number; high: number; low: number; close: number; volume: number; turnover: number }[]
}

interface NewsResult { title: string; url: string; content: string; published_date?: string }

interface PortfolioResult {
  cash: number
  market_val: number
  total_assets: number
  positions: { code: string; qty: number; cost_price: number; current_price: number; market_val: number; pl_val: number; pl_ratio: number }[]
}

type ChatBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool-call'; tool: string }
  | { kind: 'chart'; result: KLineResult }
  | { kind: 'news'; results: NewsResult[] }
  | { kind: 'portfolio'; result: PortfolioResult }
  | { kind: 'error'; message: string }

interface Msg {
  id: string
  role: 'user' | 'assistant'
  blocks: ChatBlock[]
}

const messages = ref<Msg[]>([])
const input = ref('')
const busy = ref(false)
const scroller = ref<HTMLElement | null>(null)

const clock = ref(formatClock(new Date()))
function formatClock(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ET'
}

onMounted(() => {
  setInterval(() => { clock.value = formatClock(new Date()) }, 1000)
})

const hasMessages = computed(() => messages.value.length > 0)

function scrollToBottom() {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
}

watch(messages, scrollToBottom, { deep: true })

// Append a text block (or merge into the last one if it's also text)
function appendText(asst: Msg, text: string) {
  const last = asst.blocks[asst.blocks.length - 1]
  if (last && last.kind === 'text') last.text += text
  else asst.blocks.push({ kind: 'text', text })
}

// Streaming NDJSON from /api/chat. TanStack Query doesn't model long-lived
// event streams; raw fetch + ReadableStream reader is the right tool here.
async function send() {
  const text = input.value.trim()
  if (!text || busy.value) return
  input.value = ''
  const userMsg: Msg = { id: crypto.randomUUID(), role: 'user', blocks: [{ kind: 'text', text }] }
  messages.value.push(userMsg)
  const asst: Msg = { id: crypto.randomUUID(), role: 'assistant', blocks: [] }
  messages.value.push(asst)
  busy.value = true
  try {
    const wirePayload = messages.value
      .filter(m => m.blocks.some(b => b.kind === 'text'))
      .map(m => ({
        role: m.role,
        content: m.blocks.filter((b): b is { kind: 'text'; text: string } => b.kind === 'text').map(b => b.text).join(''),
      }))
      .filter(p => p.content)

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: wirePayload }),
    })
    if (!res.body) throw new Error('no body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let chunk: StreamChunk | null = null
        try { chunk = JSON.parse(line) as StreamChunk } catch { continue }
        if (!chunk) continue
        switch (chunk.type) {
          case 'text-delta':
            appendText(asst, chunk.payload.text)
            break
          case 'tool-call':
            asst.blocks.push({ kind: 'tool-call', tool: chunk.payload.toolName })
            break
          case 'tool-result': {
            const r = chunk.payload.result as { bars?: unknown[]; results?: NewsResult[]; positions?: unknown[]; accounts?: unknown[]; orders?: unknown[] } | undefined
            if (r?.bars && Array.isArray(r.bars)) {
              asst.blocks.push({ kind: 'chart', result: r as unknown as KLineResult })
            } else if (r?.results && Array.isArray(r.results)) {
              asst.blocks.push({ kind: 'news', results: r.results as NewsResult[] })
            } else if (r?.positions && Array.isArray(r.positions)) {
              asst.blocks.push({ kind: 'portfolio', result: r as unknown as PortfolioResult })
            }
            break
          }
          case 'error':
            asst.blocks.push({ kind: 'error', message: chunk.payload.message })
            break
          case 'finish':
            // no-op
            break
        }
      }
    }
  } catch (e: unknown) {
    asst.blocks.push({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
  } finally {
    busy.value = false
  }
}

async function logout() {
  await $fetch('/api/logout', { method: 'POST' })
  await navigateTo('/login')
}

function onSelect(code: string) {
  input.value = `Show me ${code} daily`
  send()
}

const suggestions = [
  'Show me NVDA daily',
  'Any news on Arista Networks?',
  'What\'s on my watchlist?',
  'Show my paper portfolio',
]
function pickSuggestion(s: string) {
  input.value = s
  send()
}
</script>

<template>
  <div class="h-screen flex bg-[var(--ink-0)] text-[var(--paper-0)] relative">
    <WatchlistSidebar @select="onSelect" />

    <div class="flex-1 flex flex-col min-w-0 relative z-10">
      <!-- Top bar — brand wordmark, market clock, sign out -->
      <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
        <div class="flex items-baseline gap-4">
          <div class="brand-mark">
            <span>ai</span><span class="text-[var(--paper-0)]">·trader</span>
          </div>
          <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">copilot</span>
        </div>
        <div class="flex items-center gap-7">
          <div class="font-mono text-sm text-[var(--paper-2)]" data-mono>{{ clock }}</div>
          <button
            class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)] transition-colors"
            @click="logout"
          >
            sign out
          </button>
        </div>
      </header>

      <!-- Conversation -->
      <main ref="scroller" class="flex-1 overflow-y-auto">
        <!-- Empty state -->
        <div
          v-if="!hasMessages"
          class="h-full flex flex-col items-center justify-center px-6 max-w-2xl mx-auto text-center gap-10"
        >
          <div class="rise-in">
            <div class="text-5xl font-semibold tracking-tight text-[var(--paper-0)] leading-none">
              Good <span class="text-[var(--accent)]">morning</span>
            </div>
            <div class="font-mono text-sm uppercase tracking-[0.25em] text-[var(--paper-3)] mt-4">
              ask anything · charts, news, your portfolio
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3 w-full max-w-xl rise-in rise-2">
            <button
              v-for="(s, i) in suggestions"
              :key="i"
              class="text-left px-5 py-4 surface-1 hover:border-[var(--accent)] transition-colors group"
              @click="pickSuggestion(s)"
            >
              <span class="text-base font-medium text-[var(--paper-0)] group-hover:text-[var(--accent)]">{{ s }}</span>
            </button>
          </div>
        </div>

        <!-- Messages -->
        <div v-else class="max-w-3xl mx-auto px-6 py-12 space-y-12">
          <div
            v-for="m in messages"
            :key="m.id"
            class="flex flex-col gap-4 rise-in"
          >
            <div class="font-mono text-xs uppercase tracking-[0.22em]"
              :class="m.role === 'user' ? 'text-[var(--paper-3)]' : 'text-[var(--accent)]'">
              {{ m.role === 'user' ? 'you' : 'copilot' }}
            </div>
            <div v-for="(block, idx) in m.blocks" :key="idx" class="space-y-3">
              <p
                v-if="block.kind === 'text'"
                class="whitespace-pre-wrap text-base leading-[1.6] text-[var(--paper-0)]"
              >{{ block.text }}</p>
              <div v-else-if="block.kind === 'tool-call'" class="tool-rule">
                calling <span class="text-[var(--accent)] not-italic font-medium">{{ block.tool }}</span>…
              </div>
              <ChartCard
                v-else-if="block.kind === 'chart'"
                :code="block.result.code"
                :ktype="block.result.ktype"
                :bars="block.result.bars"
              />
              <NewsCard v-else-if="block.kind === 'news'" :results="block.results" />
              <PortfolioCard
                v-else-if="block.kind === 'portfolio'"
                :cash="block.result.cash"
                :market_val="block.result.market_val"
                :total_assets="block.result.total_assets"
                :positions="block.result.positions"
              />
              <div
                v-else-if="block.kind === 'error'"
                class="font-mono text-sm text-[var(--tape-down)] border-l-2 border-[var(--tape-down)] pl-3"
              >
                {{ block.message }}
              </div>
            </div>
          </div>
          <div v-if="busy" class="font-mono text-sm text-[var(--paper-3)] flex items-center gap-2">
            <span class="w-1.5 h-1.5 rounded-full bg-[var(--accent)] dot-pulse" />
            thinking…
          </div>
        </div>
      </main>

      <!-- Composer -->
      <footer class="px-6 py-5 border-t hairline shrink-0">
        <form class="max-w-3xl mx-auto flex items-center gap-3 surface-1 rounded-md px-5 py-4" @submit.prevent="send">
          <span class="font-mono text-lg text-[var(--accent)] select-none leading-none">›</span>
          <input
            v-model="input"
            class="flex-1 bg-transparent outline-none text-base text-[var(--paper-0)] placeholder:text-[var(--paper-3)]"
            placeholder="Show me NVDA daily, what's on my watchlist, any news on…"
            :disabled="busy"
          />
          <button
            type="submit"
            :disabled="busy || !input.trim()"
            class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--accent)] hover:text-[var(--paper-0)] disabled:opacity-30 disabled:hover:text-[var(--accent)] transition-colors"
          >
            send <span aria-hidden="true">⏎</span>
          </button>
        </form>
        <div class="max-w-3xl mx-auto mt-3 px-2 text-xs font-mono uppercase tracking-[0.18em] text-[var(--paper-3)]">
          model · {{ 'deepseek/deepseek-v4-flash' }} · paper trading default
        </div>
      </footer>
    </div>
  </div>
</template>
