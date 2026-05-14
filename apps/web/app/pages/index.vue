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

definePageMeta({ title: 'chat' })

const input = ref('')
const route = useRoute()
const router = useRouter()

const chatId = ref<string | null>(typeof route.query.c === 'string' ? route.query.c : null)
const conversationsList = ref<{ refresh: () => Promise<void> } | null>(null)

const drawerOpen = useState('shell.drawerOpen', () => false)

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
        router.replace({ query: { ...route.query, c: headerId } })
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

onMounted(() => { if (chatId.value) loadConversation(chatId.value) })

watch(() => route.query.c, async (next) => {
  const nextId = typeof next === 'string' ? next : null
  if (nextId === chatId.value) return
  chatId.value = nextId
  await loadConversation(nextId)
})

function startNewChat() {
  chatId.value = null
  chat.messages = []
  const { c: _drop, ...rest } = route.query
  router.replace({ query: rest })
}
function onSelectConversation(id: string) { router.push({ query: { ...route.query, c: id } }) }
function onConversationDeleted(id: string) { if (id === chatId.value) startNewChat() }
function onSubmit() {
  const text = input.value.trim()
  if (!text) return
  chat.sendMessage({ text })
  input.value = ''
}
function pickSuggestion(s: string) { input.value = s; onSubmit() }
function onSelect(code: string) {
  input.value = `Show me ${code} daily`
  onSubmit()
  // Close mobile drawer if it was open when user picked a symbol from it
  drawerOpen.value = false
}

const hasMessages = computed(() => chat.messages.length > 0)

const suggestions = [
  'Show me NVDA daily',
  'Any news on Arista Networks?',
  'What\'s on my watchlist?',
  'Show my paper portfolio',
]

function getToolOutput(part: unknown): unknown { return (part as { output?: unknown })?.output }
function hasOutput(part: unknown): boolean { return (part as { state?: string })?.state === 'output-available' }
function agentsVerdict(output: unknown) {
  const o = output as { rating?: 'strong-buy' | 'buy' | 'hold' | 'reduce' | 'sell'; confidence?: number; rationale?: string } | undefined
  if (!o?.rating) return null
  return { rating: o.rating, confidence: o.confidence ?? 0, rationale: o.rationale ?? '' }
}
</script>

<template>
  <!-- Desktop-only left rail. Mobile users get the chat full-width;
       a future iteration can move watchlist + conversations into the
       global drawer via state-shared instance. -->
  <aside class="rail-desktop hidden lg:flex">
    <div class="rail-body">
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
  </aside>

  <div class="chat-pane">
    <main class="flex-1 min-h-0 flex flex-col">
      <div
        v-if="!hasMessages"
        class="flex-1 flex flex-col items-center justify-center px-6 max-w-2xl mx-auto text-center gap-10"
      >
        <div class="rise-in">
          <div class="text-4xl sm:text-5xl font-semibold tracking-tight text-[var(--paper-0)] leading-none">
            Good <span class="text-[var(--accent)]">morning</span>
          </div>
          <div class="font-mono text-xs sm:text-sm uppercase tracking-[0.25em] text-[var(--paper-3)] mt-4">
            ask anything · charts, news, your portfolio
          </div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-xl rise-in rise-2">
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

      <UChatMessages
        v-else
        :messages="chat.messages"
        :status="chat.status"
        class="flex-1 min-h-0 max-w-3xl mx-auto w-full px-4 sm:px-6 overflow-y-auto scroll-hidden"
      >
        <template #content="{ message }">
          <template v-for="(part, idx) in message.parts" :key="`${message.id}-${idx}`">
            <UChatReasoning
              v-if="isReasoningUIPart(part)"
              :text="part.text"
              :streaming="isPartStreaming(part)"
            >
              <Comark :markdown="part.text" :streaming="isPartStreaming(part)" class="*:first:mt-0 *:last:mb-0" />
            </UChatReasoning>

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
              <AgentsDebateCard
                v-else-if="hasOutput(part) && getToolName(part) === 'agents_debate'"
                :events="(getToolOutput(part) as { events?: any[] })?.events ?? []"
                :verdict="agentsVerdict(getToolOutput(part))"
              />
              <UChatTool
                v-else
                :text="getToolName(part)"
                :streaming="isToolStreaming(part)"
              />
            </template>

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

    <footer class="px-4 sm:px-6 py-4 sm:py-5 border-t hairline shrink-0">
      <div class="max-w-3xl mx-auto">
        <UChatPrompt
          v-model="input"
          :error="chat.error"
          placeholder="Show me NVDA daily, what's on my watchlist, any news on…"
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
      </div>
    </footer>
  </div>
</template>

<style scoped>
.rail-desktop {
  width: 300px;
  flex-shrink: 0;
  border-right: 1px solid var(--hairline, rgba(255,255,255,0.06));
  flex-direction: column;
  height: 100%;
  background: var(--ink-0);
  position: relative;
  z-index: 10;
}

.rail-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.chat-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  position: relative;
  z-index: 10;
}
</style>
