import { createError, defineEventHandler, readBody } from 'h3'
import { convertToModelMessages, createUIMessageStream, stepCountIs, streamText } from 'ai'
import {
  appendMessages,
  createThread,
  getOwnerId,
  getThread,
  lastMessageId,
  titleFromText,
} from '../db/repo'
import { getApiClient } from '../llm/http'
import { getGhostfolioStatus, getGhostfolioTools, type GhostfolioStatus } from '../llm/mcp'
import { buildSystemPrompt } from '../llm/chat-context'
import { resolveModel, supportsForcedToolChoice } from '../llm/model'
import { makeTools } from '../llm/tools'
import { settleStoppedParts, stopOnAbort } from '../llm/chat-stop'
import { resolveMaxSteps } from '../llm/chat-steps'
import { watchReplyEnding } from '../llm/chat-ending'
import { ChatStreamBusyError, chatSseResponse, chatStreams } from '../lib/chat-streams'
import { within } from '../lib/within'

interface ChatBody {
  messages?: Array<{ id?: string; role: string; parts?: unknown[]; [k: string]: unknown }>
  // Client passes the active thread id when continuing a conversation.
  // Omitted on the first message of a new chat — server creates a thread
  // and returns the id in the X-Chat-Id response header, sent before any
  // model work starts, so the UI can route to it.
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
  const resolved = await resolveModel('chat')

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

  const thread = threadId

  const recordUsage = async (usage: { inputTokens?: number; outputTokens?: number }) => {
    const { recordUsageSafely } = await import('../lib/llm-cost')
    await recordUsageSafely({
      source: 'chat',
      modelSpec: resolved.spec,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    })
  }
  // The model stream's error reaches this handler again from the outer
  // stream, already described; keep the first description.
  let failure: string | null = null
  const onError = (error: unknown) => {
    failure ??= describeStreamError(error)
    return failure
  }

  try {
    chatStreams.start(thread, abortSignal => createUIMessageStream({
      execute: async ({ writer }) => {
        // Saved here, once the thread is reserved, so a send refused as busy
        // leaves no question behind. Still before any model work, so it
        // survives a refresh during streaming. A retry resends the question;
        // it is saved already unless its first send never reached us.
        if (newestUser && (!newestUser.id || newestUser.id !== await lastMessageId(thread))) {
          await appendMessages(thread, [newestUser])
        }
        const client = getApiClient()
        const [[ghostfolioTools, ghostfolioStatus], recallContext] = await Promise.all([
          within(
            Promise.all([getGhostfolioTools(), getGhostfolioStatus()]),
            MCP_PREP_MS,
            [{}, 'failing'] as [Awaited<ReturnType<typeof getGhostfolioTools>>, GhostfolioStatus],
          ),
          buildRecall(client, ownerId, newestUserText),
        ])
        const tools = stopOnAbort({ ...makeTools(client, { event, latestUserText: newestUserText }), ...ghostfolioTools })

        const modelMessages = await convertToModelMessages(
          body.messages as Parameters<typeof convertToModelMessages>[0],
          { ignoreIncompleteToolCalls: true },
        )

        const { slashDispatch, stepToolChoice } = await import('../llm/research/dispatch')
        const dispatch = slashDispatch(newestUserText)
        const systemPrompt = dispatch
          ? `${buildSystemPrompt(ghostfolioStatus, recallContext)}\n\n${dispatch.directive}`
          : buildSystemPrompt(ghostfolioStatus, recallContext)

        const maxSteps = resolveMaxSteps(body.maxSteps)
        const result = streamText({
          model: resolved.model,
          system: systemPrompt,
          messages: modelMessages,
          tools,
          abortSignal,
          stopWhen: stepCountIs(maxSteps),
          // Only pin the tool when the model accepts a forced tool_choice. DeepSeek's
          // thinking-mode models reject it with a 400 that aborts the entire stream,
          // so every slash command would fail; there the dispatch directive in the
          // system prompt carries the dispatch on its own.
          ...(dispatch && supportsForcedToolChoice(resolved)
            ? {
                prepareStep: ({ stepNumber }: { stepNumber: number }) => {
                  const tc = stepToolChoice(dispatch.toolName, stepNumber)
                  return tc === 'auto'
                    ? { toolChoice: 'auto' as const }
                    : { toolChoice: { type: 'tool' as const, toolName: dispatch.toolName as Extract<keyof typeof tools, string> } }
                },
              }
            : {}),
          onFinish: ({ totalUsage }) => recordUsage(totalUsage),
          onAbort: ({ steps }) => recordUsage({
            inputTokens: steps.reduce((n, s) => n + (s.usage.inputTokens ?? 0), 0),
            outputTokens: steps.reduce((n, s) => n + (s.usage.outputTokens ?? 0), 0),
          }),
        })
        const replyEnding = watchReplyEnding(maxSteps)
        writer.merge(result.toUIMessageStream({ onError, messageMetadata: ({ part }) => replyEnding(part) }))
      },
      onError,
      onFinish: async ({ responseMessage, isAborted }) => {
        // A reply that ended early says so on reload, where the live error is gone.
        const ending = isAborted ? { stopped: true } : failure ? { error: failure } : null
        const saved = ending
          ? {
              ...responseMessage,
              parts: isAborted ? settleStoppedParts(responseMessage.parts) : responseMessage.parts,
              metadata: { ...(responseMessage.metadata ?? {}), ...ending },
            }
          : responseMessage
        // A reply that failed or was stopped before its first chunk is saved
        // with no parts, so a reload shows why instead of an unanswered question.
        if (ending || saved.parts.length > 0) await appendMessages(thread, [saved])
      },
    }))
  } catch (err) {
    if (err instanceof ChatStreamBusyError) throw busy()
    throw err
  }

  // The chat-id round-trip: tell the client which thread we wrote to so it can
  // update its URL and refresh the conversation list.
  return chatSseResponse(chatStreams.subscribe(thread)!, {
    headers: { 'X-Chat-Id': thread, 'Access-Control-Expose-Headers': 'X-Chat-Id' },
  })
})

// A slow Ghostfolio or watchlist must not hold up the reply. mcp.ts bounds the
// connect; this also covers listing tools on a server that accepted the
// connection and then went quiet.
const MCP_PREP_MS = 3_000
const WATCHLIST_MS = 2_000
const RECALL_MS = 800

// Surface recent research runs for tickers in the user's latest message so the
// model references the agents' prior assessment. Best-effort.
async function buildRecall(client: ReturnType<typeof getApiClient>, userId: string, text: string): Promise<string> {
  try {
    const { buildRecallContext } = await import('../llm/recall')
    const watch = await within(client.listWatchlist({ group: 'All' }), WATCHLIST_MS, [])
    const watchlist = watch.map(w => String(w?.code ?? '')).filter(Boolean)
    return await within(buildRecallContext({ userId, text, watchlist }), RECALL_MS, '')
  } catch (err) {
    console.error('[chat] recall build failed', err)
    return ''
  }
}

function busy() {
  return createError({ statusCode: 409, statusMessage: 'a reply is still in progress on this chat', data: { code: 'chat_busy' } })
}

// Forward the failure into the stream as a visible message. Without this,
// an error mid-stream (e.g. context-window overflow on a long conversation)
// ends the stream silently and the chat just "stops". Surface it instead.
function describeStreamError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[chat] stream error', message)
  return `The assistant stopped early: ${message}`
}

function extractText(parts: unknown[] | undefined): string {
  if (!parts) return ''
  for (const p of parts) {
    if (p && typeof p === 'object' && (p as { type?: string }).type === 'text') {
      return String((p as { text?: string }).text ?? '')
    }
  }
  return ''
}
