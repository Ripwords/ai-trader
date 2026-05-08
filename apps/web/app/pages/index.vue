<script setup lang="ts">
import { DefaultChatTransport, type UIMessage } from 'ai'
import { Chat } from '@ai-sdk/vue'
import { computed, onMounted, ref, watch } from 'vue'
import {
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
} from 'ai'
import { isPartStreaming, isToolStreaming } from '@nuxt/ui/utils/ai'

const input = ref('')
const route = useRoute()
const router = useRouter()

// Active conversation id, mirrored to ?c=<uuid> in the URL so refreshes
// keep you on the same chat.
const chatId = ref<string | null>(typeof route.query.c === 'string' ? route.query.c : null)

const conversationsList = ref<{ refresh: () => Promise<void> } | null>(null)

// The Chat instance owns the messages array, status, and stream lifecycle.
// We pass `body: { chatId }` on every send so the server can resolve / persist.
// The transport also lets us read the X-Chat-Id response header to capture the
// id of newly-created threads.
const chat = new Chat({
  transport: new DefaultChatTransport({
    api: '/api/chat',
    prepareSendMessagesRequest: ({ messages, body }) => ({
      body: { ...body, messages, chatId: chatId.value },
    }),
    fetch: async (url, init) => {
      const res = await fetch(url, init)
      const headerId = res.headers.get('X-Chat-Id')
      if (headerId && headerId !== chatId.value) {
        chatId.value = headerId
        // Update URL without triggering a navigation
        router.replace({ query: { ...route.query, c: headerId } })
        // Refresh the sidebar list (debounced via the ref)
        setTimeout(() => conversationsList.value?.refresh(), 250)
      }
      return res
    },
  }),
  onError(err) { console.error('chat error', err) },
})

async function loadConversation(id: string | null) {
  if (!id) {
    chat.messages = []
    return
  }
  try {
    const r = await $fetch<{ messages: UIMessage[] }>(`/api/conversations/${id}`)
    chat.messages = (r.messages || []) as UIMessage[]
  } catch (e) {
    console.error('failed to load conversation', e)
    chat.messages = []
    chatId.value = null
    const { c: _, ...rest1 } = route.query
    router.replace({ query: rest1 })
  }
}

// Initial load: if URL has ?c=<id>, hydrate from the server.
onMounted(() => { if (chatId.value) loadConversation(chatId.value) })

// React to URL changes (e.g. user clicks a thread in the sidebar that updates the route)
watch(() => route.query.c, async (next) => {
  const nextId = typeof next === 'string' ? next : null
  if (nextId === chatId.value) return
  chatId.value = nextId
  await loadConversation(nextId)
})

function startNewChat() {
  chatId.value = null
  chat.messages = []
  // Drop ?c= from URL — Vue Router's `c: undefined` keeps the key.
  const { c: _drop, ...rest } = route.query
  router.replace({ query: rest })
}

function onSelectConversation(id: string) {
  router.push({ query: { ...route.query, c: id } })
}

function onConversationDeleted(id: string) {
  if (id === chatId.value) startNewChat()
}

function onSubmit() {
  const text = input.value.trim()
  if (!text) return
  chat.sendMessage({ text })
  input.value = ''
}

function pickSuggestion(s: string) {
  input.value = s
  onSubmit()
}

function onSelect(code: string) {
  input.value = `Show me ${code} daily`
  onSubmit()
}

async function logout() {
  await $fetch('/api/logout', { method: 'POST' })
  await navigateTo('/login')
}

// Live ET-style clock for the header
const clock = ref(formatClock(new Date()))
function formatClock(d: Date): string {
  return (
    d.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }) + ' ET'
  )
}
onMounted(() => {
  setInterval(() => { clock.value = formatClock(new Date()) }, 1000)
})

const hasMessages = computed(() => chat.messages.length > 0)

const suggestions = [
  'Show me NVDA daily',
  'Any news on Arista Networks?',
  'What\'s on my watchlist?',
  'Show my paper portfolio',
]

// Mirrored from server-side LLM_MODEL via NUXT_PUBLIC_LLM_MODEL.
const llmModel = useRuntimeConfig().public.llmModel || 'unset'

// Branch on tool name to decide whether to render a rich custom card
// or fall back to the default UChatTool indicator.
function getToolOutput(part: unknown): unknown {
  return (part as { output?: unknown })?.output
}
function hasOutput(part: unknown): boolean {
  return (part as { state?: string })?.state === 'output-available'
}
</script>

<template>
  <div class="h-screen flex bg-[var(--ink-0)] text-[var(--paper-0)] relative">
    <div class="w-[300px] shrink-0 border-r hairline flex flex-col h-full bg-[var(--ink-0)] relative z-10">
      <WatchlistSidebar class="!w-full !border-r-0 flex-1 min-h-0" @select="onSelect" />
      <div class="border-t hairline">
        <ConversationsList
          ref="conversationsList"
          :active-id="chatId"
          @select="onSelectConversation"
          @new="startNewChat"
          @deleted="onConversationDeleted"
        />
      </div>
    </div>

    <div class="flex-1 flex flex-col min-w-0 relative z-10">
      <!-- Top bar -->
      <header class="px-7 h-16 flex items-center justify-between border-b hairline shrink-0">
        <div class="flex items-baseline gap-4">
          <div class="brand-mark">
            <span>ai</span><span class="text-[var(--paper-0)]">·trader</span>
          </div>
          <span class="font-mono text-xs uppercase tracking-[0.2em] text-[var(--paper-3)]">copilot</span>
        </div>
        <div class="flex items-center gap-7">
          <NuxtLink
            to="/algo"
            class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)] transition-colors"
          >algo</NuxtLink>
          <div class="font-mono text-sm text-[var(--paper-2)]" data-mono>{{ clock }}</div>
          <button
            class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--paper-3)] hover:text-[var(--accent)] transition-colors"
            @click="logout"
          >
            sign out
          </button>
        </div>
      </header>

      <!-- Body — min-h-0 lets UChatMessages's internal scroll container size correctly inside the flex column -->
      <main class="flex-1 min-h-0 flex flex-col">
        <!-- Empty state -->
        <div
          v-if="!hasMessages"
          class="flex-1 flex flex-col items-center justify-center px-6 max-w-2xl mx-auto text-center gap-10"
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

        <!-- Chat list — scrollable but scrollbar hidden -->
        <UChatMessages
          v-else
          :messages="chat.messages"
          :status="chat.status"
          class="flex-1 min-h-0 max-w-3xl mx-auto w-full px-6 overflow-y-auto scroll-hidden"
        >
          <template #content="{ message }">
            <template v-for="(part, idx) in message.parts" :key="`${message.id}-${idx}`">
              <!-- Reasoning (DeepSeek reasoner / Claude thinking / etc.) -->
              <UChatReasoning
                v-if="isReasoningUIPart(part)"
                :text="part.text"
                :streaming="isPartStreaming(part)"
              >
                <Comark :markdown="part.text" :streaming="isPartStreaming(part)" class="*:first:mt-0 *:last:mb-0" />
              </UChatReasoning>

              <!-- Tool call — render rich card when output is available, else show the
                   default UChatTool indicator while it streams. -->
              <template v-else-if="isToolUIPart(part)">
                <ChartCard
                  v-if="hasOutput(part) && getToolName(part) === 'market_kline' && (getToolOutput(part) as { bars?: unknown[] })?.bars"
                  :code="(getToolOutput(part) as { code: string }).code"
                  :ktype="(getToolOutput(part) as { ktype: string }).ktype"
                  :bars="(getToolOutput(part) as { bars: any[] }).bars"
                />
                <NewsCard
                  v-else-if="hasOutput(part) && (getToolName(part) === 'search_news' || getToolName(part) === 'search_web') && (getToolOutput(part) as { results?: unknown[] })?.results"
                  :results="(getToolOutput(part) as { results: any[] }).results"
                />
                <PortfolioCard
                  v-else-if="hasOutput(part) && getToolName(part) === 'trade_portfolio' && (getToolOutput(part) as { positions?: unknown[] })?.positions"
                  :cash="(getToolOutput(part) as any).cash"
                  :market_val="(getToolOutput(part) as any).market_val"
                  :total_assets="(getToolOutput(part) as any).total_assets"
                  :positions="(getToolOutput(part) as any).positions"
                />
                <OrderCard
                  v-else-if="hasOutput(part) && getToolName(part) === 'trade_place_order' && (getToolOutput(part) as { order_id?: string })?.order_id"
                  :result="getToolOutput(part) as any"
                />
                <UChatTool
                  v-else
                  :text="getToolName(part)"
                  :streaming="isToolStreaming(part)"
                />
              </template>

              <!-- Text content — Comark for assistant (markdown), plain for user -->
              <template v-else-if="isTextUIPart(part)">
                <Comark
                  v-if="message.role === 'assistant'"
                  :markdown="part.text"
                  :streaming="isPartStreaming(part)"
                  class="*:first:mt-0 *:last:mb-0 prose-invert"
                />
                <p
                  v-else-if="message.role === 'user'"
                  class="whitespace-pre-wrap text-base leading-[1.6] text-[var(--paper-0)]"
                >{{ part.text }}</p>
              </template>
            </template>
          </template>
        </UChatMessages>
      </main>

      <!-- Composer -->
      <footer class="px-6 py-5 border-t hairline shrink-0">
        <div class="max-w-3xl mx-auto">
          <UChatPrompt
            v-model="input"
            :error="chat.error"
            placeholder="Show me NVDA daily, what's on my watchlist, any news on…"
            :ui="{
              body: '!pe-11',
            }"
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
          <div class="mt-3 px-2 text-xs font-mono uppercase tracking-[0.18em] text-[var(--paper-3)]">
            model · {{ llmModel }} · live data · paper writes
          </div>
        </div>
      </footer>
    </div>
  </div>
</template>
