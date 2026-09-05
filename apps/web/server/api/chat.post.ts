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
import { buildModel, DEFAULT_MODEL_SPEC, supportsForcedToolChoice } from '../llm/model'
import { makeTools } from '../llm/tools'
import { resolveMaxSteps } from '../llm/chat-steps'

interface ChatBody {
  messages?: Array<{ id?: string; role: string; parts?: unknown[]; [k: string]: unknown }>
  // Client passes the active thread id when continuing a conversation.
  // Omitted on the first message of a new chat — server creates a thread
  // and returns the id in the X-Chat-Id response header so the UI can route to it.
  chatId?: string
  // Max agentic steps (model generations) for this turn. Client-controlled so
  // the user can raise it for deep multi-tool work; defaults to 30 server-side.
  maxSteps?: number
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

  // Auto-hint: surface recent research runs for tickers in the user's latest
  // message so the model references the agents' prior assessment instead of
  // being blind to it. Best-effort — never block the chat on it.
  let recallContext = ''
  try {
    const { buildRecallContext } = await import('../llm/recall')
    const watch = await client.listWatchlist({ group: 'All' }).catch(() => [] as Array<{ code?: string }>)
    const watchSymbols = (Array.isArray(watch) ? watch : []).map(w => String(w?.code ?? '')).filter(Boolean)
    recallContext = await Promise.race([
      buildRecallContext({ userId: ownerId, text: newestUserText, watchlist: watchSymbols }),
      new Promise<string>(r => setTimeout(() => r(''), 800)),
    ])
  } catch (err) {
    console.error('[chat] recall build failed', err)
  }

  const modelMessages = await convertToModelMessages(
    body.messages as Parameters<typeof convertToModelMessages>[0],
  )

  const { slashDispatch, stepToolChoice } = await import('../llm/research/dispatch')
  const dispatch = slashDispatch(newestUserText)
  const systemPrompt = dispatch
    ? `${buildSystemPrompt(ghostfolioStatus, recallContext)}\n\n${dispatch.directive}`
    : buildSystemPrompt(ghostfolioStatus, recallContext)

  const maxSteps = resolveMaxSteps(body.maxSteps)
  const result = streamText({
    model: buildModel(),
    system: systemPrompt,
    messages: modelMessages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    // Only pin the tool when the model accepts a forced tool_choice. DeepSeek's
    // thinking-mode models reject it with a 400 that aborts the entire stream,
    // so every slash command would fail; there the dispatch directive in the
    // system prompt carries the dispatch on its own.
    ...(dispatch && supportsForcedToolChoice()
      ? {
          prepareStep: ({ stepNumber }: { stepNumber: number }) => {
            const tc = stepToolChoice(dispatch.toolName, stepNumber)
            return tc === 'auto'
              ? { toolChoice: 'auto' as const }
              : { toolChoice: { type: 'tool' as const, toolName: dispatch.toolName as Extract<keyof typeof tools, string> } }
          },
        }
      : {}),
  })

  // The chat-id round-trip: tell the client which thread we wrote to so it can
  // update its URL and refresh the conversation list.
  setResponseHeader(event, 'X-Chat-Id', threadId)
  setResponseHeader(event, 'Access-Control-Expose-Headers', 'X-Chat-Id')

  // Persist the full assistant response when streaming completes.
  const modelSpec = process.env.LLM_MODEL || DEFAULT_MODEL_SPEC
  return result.toUIMessageStreamResponse({
    // Forward the failure into the stream as a visible message. Without this,
    // an error mid-stream (e.g. context-window overflow on a long conversation)
    // ends the stream silently and the chat just "stops". Surface it instead.
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[chat] stream error', message)
      return `The assistant stopped early: ${message}`
    },
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
