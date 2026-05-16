import { convertToModelMessages, stepCountIs, streamText } from 'ai'
import {
  appendMessages,
  createThread,
  getOwnerId,
  getThread,
  titleFromText,
} from '../db/repo'
import { getApiClient } from '../llm/http'
import { getGhostfolioStatus, getGhostfolioTools } from '../llm/mcp'
import { buildSystemPrompt } from '../llm/chat-context'
import { buildModel, DEFAULT_MODEL_SPEC } from '../llm/model'
import { makeTools } from '../llm/tools'

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
  const newestUserText = extractText(newestUser?.parts as unknown[] | undefined)

  // Resolve thread: validate provided id OR create one from the first user message.
  let threadId = body.chatId
  if (threadId) {
    const existing = await getThread(ownerId, threadId)
    if (!existing) threadId = undefined
  }
  if (!threadId) {
    threadId = await createThread(ownerId, titleFromText(newestUserText || 'New chat'))
  }

  // Persist the user message immediately so it survives a refresh during streaming.
  if (newestUser) {
    await appendMessages(threadId, [newestUser])
  }

  const client = getApiClient()
  const [ghostfolioTools, ghostfolioStatus] = await Promise.all([
    getGhostfolioTools(),
    getGhostfolioStatus(),
  ])
  const tools = { ...makeTools(client, { event, latestUserText: newestUserText }), ...ghostfolioTools }
  const modelMessages = await convertToModelMessages(
    body.messages as Parameters<typeof convertToModelMessages>[0],
  )

  const result = streamText({
    model: buildModel(),
    system: buildSystemPrompt(ghostfolioStatus),
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(8),
  })

  // The chat-id round-trip: tell the client which thread we wrote to so it can
  // update its URL and refresh the conversation list.
  setResponseHeader(event, 'X-Chat-Id', threadId)
  setResponseHeader(event, 'Access-Control-Expose-Headers', 'X-Chat-Id')

  // Persist the full assistant response when streaming completes.
  const modelSpec = process.env.LLM_MODEL || DEFAULT_MODEL_SPEC
  return result.toUIMessageStreamResponse({
    onFinish: async ({ messages: finalMessages }) => {
      try {
        const totalUsage = await result.totalUsage
        if (totalUsage) {
          const { recordUsageSafely } = await import('../lib/llm-cost')
          await recordUsageSafely({
            source: 'chat',
            modelSpec,
            inputTokens: totalUsage.inputTokens ?? 0,
            outputTokens: totalUsage.outputTokens ?? 0,
          })
        }
      } catch (err) {
        console.error('[chat] usage record failed', err)
      }
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
