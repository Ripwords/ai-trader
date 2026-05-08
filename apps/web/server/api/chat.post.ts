import { convertToModelMessages, stepCountIs, streamText } from 'ai'
import {
  appendMessages,
  createThread,
  getOwnerId,
  getThread,
  titleFromText,
} from '../db/repo'
import { getApiClient } from '../llm/http'
import { buildModel } from '../llm/model'
import { MOOMOO_RULES } from '../llm/moomoo-context'
import { makeTools } from '../llm/tools'

const SYSTEM_PROMPT = [
  'You are a trading copilot. The user has a moomoo OpenD account.',
  'When the user asks for a chart, ALWAYS call market_kline and present the result.',
  'When the user asks for a price, call market_snapshot.',
  'When the user wants to track a symbol, use watchlist_add. When they ask what they\'re tracking, use watchlist_list.',
  'For news / market context / company headlines, call search_news.',
  'For general facts or definitions, call search_web.',
  'For account/portfolio/orders/fills: call trade_accounts first to find acc_id, then trade_portfolio / trade_orders / trade_fills.',
  'Never invent symbols — ask if unsure. The lookup table below is authoritative for common names.',
  '',
  MOOMOO_RULES,
].join('\n')

interface ChatBody {
  messages?: Array<{ id?: string; role: string; parts?: unknown[]; [k: string]: unknown }>
  // Client passes the active thread id when continuing a conversation.
  // Omitted on the first message of a new chat — server creates a thread
  // and returns the id in the X-Chat-Id response header so the UI can route to it.
  chatId?: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<ChatBody>(event)
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'messages must be a non-empty array' })
  }

  const ownerId = await getOwnerId()
  const newestUser = [...body.messages].reverse().find(m => m.role === 'user')

  // Resolve thread: validate provided id OR create one from the first user message.
  let threadId = body.chatId
  if (threadId) {
    const existing = await getThread(ownerId, threadId)
    if (!existing) threadId = undefined
  }
  if (!threadId) {
    const firstText =
      typeof (newestUser as { parts?: unknown })?.parts === 'object'
        ? extractText(newestUser?.parts as unknown[])
        : 'New chat'
    threadId = await createThread(ownerId, titleFromText(firstText || 'New chat'))
  }

  // Persist the user message immediately so it survives a refresh during streaming.
  if (newestUser) {
    await appendMessages(threadId, [newestUser])
  }

  const client = getApiClient()
  const tools = makeTools(client)
  const modelMessages = await convertToModelMessages(
    body.messages as Parameters<typeof convertToModelMessages>[0],
  )

  const result = streamText({
    model: buildModel(),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(8),
  })

  // The chat-id round-trip: tell the client which thread we wrote to so it can
  // update its URL and refresh the conversation list.
  setResponseHeader(event, 'X-Chat-Id', threadId)
  setResponseHeader(event, 'Access-Control-Expose-Headers', 'X-Chat-Id')

  // Persist the full assistant response when streaming completes.
  return result.toUIMessageStreamResponse({
    onFinish: async ({ messages: finalMessages }) => {
      const assistantOnly = finalMessages.filter(m => m.role === 'assistant')
      if (assistantOnly.length > 0) {
        await appendMessages(threadId!, assistantOnly as unknown as Parameters<typeof appendMessages>[1])
      }
    },
  })
})

function extractText(parts: unknown[] | undefined): string {
  if (!parts) return ''
  for (const p of parts) {
    if (p && typeof p === 'object' && (p as { type?: string }).type === 'text') {
      return String((p as { text?: string }).text ?? '')
    }
  }
  return ''
}
