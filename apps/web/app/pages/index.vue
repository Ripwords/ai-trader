<script setup lang="ts">
import { DefaultChatTransport, type UIMessage } from 'ai'
import { Chat } from '@ai-sdk/vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
} from 'ai'
import { isPartStreaming, isToolStreaming } from '@nuxt/ui/utils/ai'
import { BorderBeam } from 'vue-border-beam'
import { requestRunNotificationPermission } from '../lib/notify'
import { cycleIndex, filterCommandPalette, splitSlashHighlight, type PaletteItem } from '../lib/slash'

definePageMeta({ title: 'chat' })

const input = ref('')
const route = useRoute()
const router = useRouter()

// Max agentic steps (model turns) per message. Higher = the assistant can chain
// more tool calls before it must produce a final answer; keeps long multi-tool
// conversations from stopping early. Persisted locally; sent to /api/chat.
const MAX_STEPS_MIN = 1
const MAX_STEPS_MAX = 100
const DEFAULT_MAX_STEPS = 30
const maxSteps = ref(DEFAULT_MAX_STEPS)
onMounted(() => {
  const saved = Number(localStorage.getItem('chat:maxSteps'))
  if (Number.isFinite(saved) && saved >= MAX_STEPS_MIN && saved <= MAX_STEPS_MAX) {
    maxSteps.value = saved
  }
})
watch(maxSteps, (v) => {
  const clamped = Math.min(MAX_STEPS_MAX, Math.max(MAX_STEPS_MIN, Math.round(v || DEFAULT_MAX_STEPS)))
  if (clamped !== v) {
    maxSteps.value = clamped
    return
  }
  localStorage.setItem('chat:maxSteps', String(clamped))
})
function bumpMaxSteps(delta: number) {
  maxSteps.value = Math.min(MAX_STEPS_MAX, Math.max(MAX_STEPS_MIN, maxSteps.value + delta))
}

const slashCommands = ref<PaletteItem[]>([])
const slashSuggestions = computed(() => filterCommandPalette(input.value, slashCommands.value))
const slashCommandNames = computed(() => slashCommands.value.map(c => c.name))
const slashActiveIndex = ref(0)
const slashDismissed = ref(false)
const slashOpen = computed(() => slashSuggestions.value.length > 0 && !slashDismissed.value)
async function ensureCommands() {
  if (slashCommands.value.length) return
  try {
    const r = await $fetch<{ commands: PaletteItem[] }>('/api/chat/commands')
    slashCommands.value = r.commands ?? []
  } catch { /* palette is optional */ }
  void nextTick(syncSlashMirror)
}
function applySlash(name: string) {
  input.value = `/${name} `
  slashDismissed.value = true
}
watch(input, (v) => {
  if (v.startsWith('/')) void ensureCommands()
  slashDismissed.value = false
  void nextTick(syncSlashMirror)
})
watch(slashSuggestions, (list) => {
  if (slashActiveIndex.value > list.length - 1) slashActiveIndex.value = 0
})

// Keyboard-driven palette: intercepted in the CAPTURE phase on the prompt
// wrapper so it fires before UChatPrompt's own textarea Enter handler (which
// would otherwise submit the message). stopPropagation prevents that submit.
function onPromptKeydown(e: KeyboardEvent) {
  if (!slashOpen.value) return
  const list = slashSuggestions.value
  switch (e.key) {
    case 'ArrowDown':
      slashActiveIndex.value = cycleIndex(slashActiveIndex.value, list.length, 1)
      e.preventDefault(); e.stopPropagation(); break
    case 'ArrowUp':
      slashActiveIndex.value = cycleIndex(slashActiveIndex.value, list.length, -1)
      e.preventDefault(); e.stopPropagation(); break
    case 'Tab':
    case 'Enter': {
      const pick = list[slashActiveIndex.value]
      if (pick) applySlash(pick.name)
      e.preventDefault(); e.stopPropagation(); break
    }
    case 'Escape':
      slashDismissed.value = true
      e.preventDefault(); e.stopPropagation(); break
  }
}

// --- Slash-command text highlighting --------------------------------------
// A <textarea> cannot colour a substring, so when the input starts with a
// recognised /command we hide the textarea's own glyphs (color: transparent,
// caret kept) and render a pixel-aligned mirror on top that paints the command
// token in the accent colour and the rest in the textarea's normal colour.
const promptWrap = ref<HTMLElement | null>(null)
const slashMirror = ref<HTMLElement | null>(null)
const slashHighlight = computed(() => splitSlashHighlight(input.value, slashCommandNames.value))
const mirrorStyle = ref<Record<string, string>>({ display: 'none' })
const inputFocused = ref(false)
let mirrorObserver: ResizeObserver | null = null

// The border beam is an idle-only cue: it plays only when the input is neither
// focused nor showing a command highlight, so it never competes with the focus
// ring or the highlighted command.
const beamActive = computed(() => !slashHighlight.value.cmd && !inputFocused.value)

function findTextarea(): HTMLTextAreaElement | null {
  return promptWrap.value?.querySelector('textarea') ?? null
}
function onInputFocus() { inputFocused.value = true }
function onInputBlur() { inputFocused.value = false }

function syncSlashMirror() {
  const mirror = slashMirror.value
  const ta = findTextarea()
  if (!mirror || !ta || !slashHighlight.value.cmd) {
    mirrorStyle.value = { display: 'none' }
    return
  }
  const host = (mirror.offsetParent as HTMLElement | null) ?? ta.parentElement!
  const tr = ta.getBoundingClientRect()
  const hr = host.getBoundingClientRect()
  const cs = getComputedStyle(ta)
  mirrorStyle.value = {
    position: 'absolute',
    left: `${tr.left - hr.left}px`,
    top: `${tr.top - hr.top}px`,
    width: `${tr.width}px`,
    height: `${tr.height}px`,
    boxSizing: 'border-box',
    paddingTop: cs.paddingTop,
    paddingRight: cs.paddingRight,
    paddingBottom: cs.paddingBottom,
    paddingLeft: cs.paddingLeft,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    tabSize: cs.tabSize,
    textAlign: cs.textAlign,
    color: cs.color,
  }
  mirror.scrollTop = ta.scrollTop
}

onMounted(() => {
  const ta = findTextarea()
  if (ta && 'ResizeObserver' in window) {
    mirrorObserver = new ResizeObserver(() => syncSlashMirror())
    mirrorObserver.observe(ta)
    ta.addEventListener('scroll', syncSlashMirror, { passive: true })
  }
  if (ta) {
    inputFocused.value = document.activeElement === ta
    ta.addEventListener('focus', onInputFocus)
    ta.addEventListener('blur', onInputBlur)
  }
  window.addEventListener('resize', syncSlashMirror, { passive: true })
})

const chatId = ref<string | null>(typeof route.query.c === 'string' ? route.query.c : null)
const conversationsList = ref<{ refresh: () => Promise<void> } | null>(null)

const drawerOpen = useState('shell.drawerOpen', () => false)

interface ConversationMetadata {
  pinned: boolean
  archived: boolean
  summary?: string
  decisions: Array<{ id: string; title: string; note?: string; created_at: string }>
}

type ContextStatus = 'ok' | 'warn' | 'critical'

interface ChatContextInfo {
  modelSpec: string
  contextWindow: number
  contextWindowSource: 'env' | 'known' | 'fallback'
  estimatedInputTokens: number
  outputReserveTokens: number
  estimatedTotalTokens: number
  remainingTokens: number
  usagePct: number
  status: ContextStatus
  approximate: boolean
}

const contextInfo = ref<ChatContextInfo | null>(null)
const contextPending = ref(false)
const contextError = ref<string | null>(null)
const activeConversationMetadata = ref<ConversationMetadata | null>(null)
const conversationAction = ref<'summary' | 'decision' | ''>('')
const conversationMessage = ref('')
let contextTimer: ReturnType<typeof setTimeout> | null = null
let contextSeq = 0

const chat = new Chat({
  transport: new DefaultChatTransport({
    api: '/api/chat',
    prepareSendMessagesRequest: ({ messages, body }) => ({
      body: { ...body, messages, chatId: chatId.value, maxSteps: maxSteps.value },
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
    activeConversationMetadata.value = null
    scheduleContextEstimate(0)
    return
  }
  try {
    const r = await $fetch<{ metadata: ConversationMetadata; messages: UIMessage[] }>(`/api/conversations/${id}`)
    chat.messages = (r.messages || []) as UIMessage[]
    activeConversationMetadata.value = r.metadata
    scheduleContextEstimate(0)
  } catch (e) {
    console.error('failed to load conversation', e)
    chat.messages = []
    activeConversationMetadata.value = null
    chatId.value = null
    const { c: _, ...rest1 } = route.query
    router.replace({ query: rest1 })
    scheduleContextEstimate(0)
  }
}

onMounted(async () => {
  if (chatId.value) await loadConversation(chatId.value)
  else scheduleContextEstimate(0)
})

onBeforeUnmount(() => {
  if (contextTimer) clearTimeout(contextTimer)
  mirrorObserver?.disconnect()
  const ta = findTextarea()
  ta?.removeEventListener('scroll', syncSlashMirror)
  ta?.removeEventListener('focus', onInputFocus)
  ta?.removeEventListener('blur', onInputBlur)
  window.removeEventListener('resize', syncSlashMirror)
})

watch(() => route.query.c, async (next) => {
  const nextId = typeof next === 'string' ? next : null
  if (nextId === chatId.value) return
  chatId.value = nextId
  await loadConversation(nextId)
})

function startNewChat() {
  chatId.value = null
  chat.messages = []
  activeConversationMetadata.value = null
  conversationMessage.value = ''
  const { c: _drop, ...rest } = route.query
  router.replace({ query: rest })
  scheduleContextEstimate(0)
}
function onSelectConversation(id: string) { router.push({ query: { ...route.query, c: id } }) }
function onConversationDeleted(id: string) { if (id === chatId.value) startNewChat() }
function onSubmit() {
  const text = input.value.trim()
  if (!text) return
  void requestRunNotificationPermission()
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

async function summarizeActiveConversation() {
  if (!chatId.value) return
  conversationAction.value = 'summary'
  conversationMessage.value = ''
  try {
    const r = await $fetch<{ metadata: ConversationMetadata; summary: string }>(`/api/conversations/${chatId.value}/summary`, {
      method: 'POST',
    })
    activeConversationMetadata.value = r.metadata
    conversationMessage.value = 'summary saved'
    await conversationsList.value?.refresh()
  } catch (e) {
    conversationMessage.value = e instanceof Error ? e.message : 'summary failed'
  } finally {
    conversationAction.value = ''
  }
}

async function recordActiveDecision() {
  if (!chatId.value) return
  conversationAction.value = 'decision'
  conversationMessage.value = ''
  try {
    const r = await $fetch<{ metadata: ConversationMetadata }>(`/api/conversations/${chatId.value}/decision`, {
      method: 'POST',
      body: {},
    })
    activeConversationMetadata.value = r.metadata
    conversationMessage.value = 'decision recorded'
    await conversationsList.value?.refresh()
  } catch (e) {
    conversationMessage.value = e instanceof Error ? e.message : 'decision failed'
  } finally {
    conversationAction.value = ''
  }
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
function getPartState(part: unknown): string | undefined { return (part as { state?: string })?.state }

async function refreshContextEstimate() {
  const seq = ++contextSeq
  contextPending.value = true
  contextError.value = null
  try {
    const info = await $fetch<ChatContextInfo>('/api/chat-context', {
      method: 'POST',
      body: { messages: chat.messages },
    })
    if (seq !== contextSeq) return
    contextInfo.value = info
  } catch (e) {
    if (seq !== contextSeq) return
    contextError.value = e instanceof Error ? e.message : 'failed to estimate context'
  } finally {
    if (seq === contextSeq) contextPending.value = false
  }
}

function scheduleContextEstimate(delay = 350) {
  if (contextTimer) clearTimeout(contextTimer)
  contextTimer = setTimeout(() => {
    contextTimer = null
    void refreshContextEstimate()
  }, delay)
}

watch(
  () => chat.messages,
  () => scheduleContextEstimate(chat.status === 'ready' ? 350 : 900),
  { deep: true },
)

watch(
  () => chat.status,
  () => scheduleContextEstimate(chat.status === 'ready' ? 250 : 900),
)

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

const contextPct = computed(() => Math.min(100, Math.round((contextInfo.value?.usagePct ?? 0) * 100)))
const contextToneClass = computed(() => {
  if (contextInfo.value?.status === 'critical') return 'text-[var(--tape-down)]'
  if (contextInfo.value?.status === 'warn') return 'text-[var(--accent)]'
  return 'text-[var(--paper-2)]'
})
const contextBarClass = computed(() => {
  if (contextInfo.value?.status === 'critical') return 'bg-[var(--tape-down)]'
  if (contextInfo.value?.status === 'warn') return 'bg-[var(--accent)]'
  return 'bg-[var(--paper-2)]'
})
const contextTooltip = computed(() => {
  if (!contextInfo.value) return 'Context estimate is loading'
  const src = contextInfo.value.contextWindowSource === 'env' ? 'configured' : 'model default'
  return `Approximate prompt + output reserve: ${formatTokens(contextInfo.value.estimatedTotalTokens)} / ${formatTokens(contextInfo.value.contextWindow)} tokens (${src})`
})
const activeToolNames = computed(() => {
  const names = new Set<string>()
  for (const message of chat.messages) {
    for (const part of message.parts ?? []) {
      if (!isToolUIPart(part)) continue
      if (getPartState(part) === 'output-error') continue
      if (isToolStreaming(part) || !hasOutput(part)) names.add(getToolName(part))
    }
  }
  return [...names]
})
const liveStatusText = computed(() => {
  if (activeToolNames.value.length > 0) {
    return activeToolNames.value.length === 1
      ? `running ${activeToolNames.value[0]}`
      : `running ${activeToolNames.value.length} tools`
  }
  if (chat.status === 'submitted') return 'waiting for model'
  if (chat.status === 'streaming') return 'streaming response'
  return ''
})
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
                :currency="(getToolOutput(part) as any).currency"
              />
              <PortfolioMptCard
                v-else-if="hasOutput(part) && getToolName(part) === 'portfolio_mpt_analysis'"
                :analysis="getToolOutput(part) as any"
              />
              <OrderCard
                v-else-if="hasOutput(part) && getToolName(part) === 'trade_place_order' && (getToolOutput(part) as { order_id?: string })?.order_id"
                :result="getToolOutput(part) as any"
              />
              <AgentsDebateCard
                v-else-if="hasOutput(part) && getToolName(part) === 'agents_debate'"
                :events="(getToolOutput(part) as { events?: any[] })?.events ?? []"
                :verdict="agentsVerdict(getToolOutput(part))"
                :error="(getToolOutput(part) as { error?: string })?.error ?? null"
                :running="isToolStreaming(part) && !agentsVerdict(getToolOutput(part))"
              />
              <ValuationCard
                v-else-if="hasOutput(part) && getToolName(part) === 'value_stock' && (getToolOutput(part) as any)?.veto"
                :result="getToolOutput(part) as any"
              />
              <ToolStatusCard
                v-else
                :tool-name="getToolName(part)"
                :state="getPartState(part)"
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
        <div class="mb-3 space-y-2">
          <div
            v-if="chatId"
            class="border hairline bg-[var(--ink-2)] px-3 py-2"
          >
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div class="min-w-0">
                <div class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--paper-3)]">
                  chat memory
                  <span v-if="activeConversationMetadata?.decisions.length" class="text-[var(--paper-2)]">
                    · {{ activeConversationMetadata.decisions.length }} decision{{ activeConversationMetadata.decisions.length === 1 ? '' : 's' }}
                  </span>
                </div>
                <div class="mt-1 text-xs text-[var(--paper-2)] truncate">
                  {{ activeConversationMetadata?.summary || conversationMessage || 'save a summary or decision record for this chat' }}
                </div>
              </div>
              <div class="shrink-0 flex items-center gap-3">
                <button
                  class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--paper-3)] hover:text-[var(--accent)] disabled:opacity-40 disabled:hover:text-[var(--paper-3)]"
                  :disabled="!!conversationAction"
                  @click="summarizeActiveConversation()"
                >
                  {{ conversationAction === 'summary' ? 'saving…' : 'summarize' }}
                </button>
                <button
                  class="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--paper-3)] hover:text-[var(--accent)] disabled:opacity-40 disabled:hover:text-[var(--paper-3)]"
                  :disabled="!!conversationAction"
                  @click="recordActiveDecision()"
                >
                  {{ conversationAction === 'decision' ? 'saving…' : 'decision' }}
                </button>
              </div>
            </div>
          </div>
          <div
            v-if="liveStatusText"
            class="flex items-center justify-between gap-4 font-mono text-xs uppercase tracking-[0.16em] text-[var(--paper-3)]"
          >
            <span>{{ liveStatusText }}</span>
            <span class="size-2 rounded-full bg-[var(--accent)] dot-pulse shrink-0" />
          </div>

          <div
            class="space-y-1"
            :title="contextTooltip"
          >
            <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-xs uppercase tracking-[0.14em]">
              <div class="min-w-0 text-[var(--paper-3)] truncate">
                model
                <span class="text-[var(--paper-2)] normal-case tracking-normal">{{ contextInfo?.modelSpec ?? 'loading' }}</span>
              </div>
              <div
                class="flex items-center gap-1 text-[var(--paper-3)]"
                title="Max agentic steps (model turns) per message. Raise this for deep multi-tool research so the assistant doesn't stop early."
              >
                <span>steps</span>
                <button
                  type="button"
                  class="size-4 inline-flex items-center justify-center leading-none hover:text-[var(--accent)] disabled:opacity-40"
                  :disabled="maxSteps <= MAX_STEPS_MIN"
                  @click="bumpMaxSteps(-5)"
                >−</button>
                <input
                  v-model.number="maxSteps"
                  type="number"
                  :min="MAX_STEPS_MIN"
                  :max="MAX_STEPS_MAX"
                  class="w-8 bg-transparent text-center text-[var(--paper-2)] normal-case tracking-normal outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  aria-label="max agentic steps per message"
                >
                <button
                  type="button"
                  class="size-4 inline-flex items-center justify-center leading-none hover:text-[var(--accent)] disabled:opacity-40"
                  :disabled="maxSteps >= MAX_STEPS_MAX"
                  @click="bumpMaxSteps(5)"
                >+</button>
              </div>
              <div v-if="contextError" class="text-[var(--tape-down)]">
                context unavailable
              </div>
              <div v-else class="text-[var(--paper-3)]">
                context
                <span :class="contextToneClass">
                  {{ contextInfo ? `${formatTokens(contextInfo.estimatedTotalTokens)} / ${formatTokens(contextInfo.contextWindow)} (${contextPct}%)` : 'estimating' }}
                </span>
                <span v-if="contextPending" class="text-[var(--paper-3)]">...</span>
              </div>
            </div>
            <div class="h-1 bg-[var(--ink-2)] rounded-sm overflow-hidden">
              <div
                class="h-full transition-[width] duration-300"
                :class="contextBarClass"
                :style="{ width: contextInfo ? `${contextPct}%` : '8%' }"
              />
            </div>
          </div>
        </div>
        <div
          ref="promptWrap"
          class="prompt-wrap"
          :class="{ 'slash-hl': slashHighlight.cmd }"
          @keydown.capture="onPromptKeydown"
        >
          <div v-if="slashOpen" class="slash-palette">
            <button
              v-for="(s, i) in slashSuggestions"
              :key="s.name"
              type="button"
              class="slash-item"
              :class="{ 'slash-item--active': i === slashActiveIndex }"
              @click="applySlash(s.name)"
              @mousemove="slashActiveIndex = i"
            >
              <span class="slash-name">/{{ s.name }}</span>
              <span class="slash-desc">{{ s.description }}</span>
            </button>
          </div>
          <!-- BorderBeam gates its render on onMounted, so it must be
               client-only to avoid a hydration mismatch. It wraps the input
               and traces an animated beam around its border. -->
          <ClientOnly>
            <BorderBeam
              size="md"
              color-variant="sunset"
              theme="dark"
              :duration="7"
              :border-radius="8"
              :active="beamActive"
              :strength="0.25"
              :brightness="0.7"
              :saturation="0.9"
              class="beam-frame"
            >
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
            </BorderBeam>
            <template #fallback>
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
            </template>
          </ClientOnly>
          <div
            v-show="slashHighlight.cmd"
            ref="slashMirror"
            class="slash-mirror"
            :style="mirrorStyle"
            aria-hidden="true"
          ><span class="mirror-cmd">{{ slashHighlight.cmd }}</span><span class="mirror-rest">{{ slashHighlight.rest }}</span></div>
        </div>
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

.prompt-wrap {
  position: relative;
}

.slash-palette {
  border: 1px solid var(--hairline, rgba(255,255,255,0.06));
  border-radius: 6px;
  background: var(--ink-1, #111);
  margin-bottom: 4px;
  overflow: hidden;
}

.slash-item--active {
  background: var(--ink-2, #1a1a1a);
}

.slash-item--active .slash-desc {
  color: var(--paper-2, rgba(255,255,255,0.7));
}

.beam-frame {
  position: relative;
}

/* When a recognised command is present, hide the textarea's own glyphs (keep
   the caret) so the mirror on top is the only visible text. Background is left
   untouched so the dark theme is preserved. */
.slash-hl :deep(textarea) {
  color: transparent;
  -webkit-text-fill-color: transparent;
  caret-color: var(--paper-0, #fff);
}

/* Text-highlight overlay: pixel-aligned with the textarea, painting the
   command token in the accent colour and the rest in the normal text colour
   (inherited from the inline `color` copied off the textarea). */
.slash-mirror {
  z-index: 5;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  pointer-events: none;
  overflow: hidden;
  user-select: none;
}

.mirror-cmd {
  color: var(--accent, #d4a96a);
  font-weight: 500;
}

.slash-item {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  width: 100%;
  padding: 6px 12px;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: inherit;
}

.slash-item:hover {
  background: var(--ink-2, #1a1a1a);
}

.slash-name {
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--accent, #d4a96a);
  white-space: nowrap;
}

.slash-desc {
  font-size: 0.75rem;
  color: var(--paper-3, rgba(255,255,255,0.4));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
