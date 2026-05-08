import { convertToModelMessages, stepCountIs, streamText } from 'ai'
import {
  appendMessages,
  createThread,
  getOwnerId,
  getThread,
  titleFromText,
} from '../db/repo'
import { getApiClient } from '../llm/http'
import { getGhostfolioTools } from '../llm/mcp'
import { buildModel } from '../llm/model'
import { MOOMOO_RULES } from '../llm/moomoo-context'
import { makeTools } from '../llm/tools'

function buildSystemPrompt(hasGhostfolio: boolean): string {
  return [
    'You are a trading copilot. The user has a moomoo OpenD account.',
    hasGhostfolio
      ? 'Cross-broker portfolio truth lives in Ghostfolio (exposed via ghostfolio_* MCP tools).'
      : 'Ghostfolio cross-broker tools are NOT enabled in this session — do not promise or reference ghostfolio_* tools. If the user asks about cross-broker holdings, say Ghostfolio integration is not currently configured (the user can enable it via `docker compose --profile ghostfolio up` once they set GHOSTFOLIO_URL and GHOSTFOLIO_TOKEN in .env).',
    'When the user asks for a chart, ALWAYS call market_kline and present the result.',
    'When the user asks for a price, call market_snapshot.',
    'When the user wants to track a symbol, use watchlist_add. When they ask what they\'re tracking, use watchlist_list.',
    'For news / market context / company headlines, call search_news.',
    'For general facts or definitions, call search_web.',
    'For their broker-side moomoo account/portfolio/orders/fills: call trade_accounts first to find acc_id, then trade_portfolio / trade_orders / trade_fills.',
    hasGhostfolio
      ? 'For the user\'s overall holdings ACROSS brokers (the source of truth they care about), prefer the ghostfolio_* tools — Ghostfolio aggregates all their accounts. Use moomoo trade_* tools when they specifically ask about the moomoo account.'
      : 'For portfolio / holdings, use the moomoo trade_* tools — that\'s the only broker data we have access to right now.',
    '',
    'TRADE QUERIES (portfolio / orders / fills):',
    '- Default to LIVE (trd_env=REAL) — that\'s the user\'s real money and the data they care about.',
    '- The user must have a NORMAL (non-IPO) live account: filter trade_accounts results to acc_role !== "IPO".',
    '- Only use trd_env=SIMULATE when the user explicitly asks about "paper" or "simulated".',
    '',
    'TRADE WRITES (place / modify / cancel orders):',
    '- Default to PAPER (trd_env=SIMULATE). NEVER pass trd_env=REAL on a write tool unless the user has said "live" or "real" in this turn.',
    '- Before calling trade_place_order, briefly state the order back ("Placing a paper buy of 5 US.NVDA at $215 limit, ok?") and only call the tool if the user confirms with a clear yes (or already confirmed in this message).',
    '- For modify/cancel, you need order_id and acc_id. List orders first with trade_orders if you don\'t have them.',
    '- If a live order returns "unlock needed" / "trade is locked", tell the user to manually click "Unlock Trade" in the moomoo OpenD GUI — never offer to call unlock_trade from the SDK (it\'s not exposed).',
    '',
    'ALGO TRADING (algo_* tools):',
    '- Strategies are user-authored Python (sandboxed). The user lists/edits them at /algo. Use algo_list to find ids, algo_backtest to test against history (read-only), algo_recent_signals to see what live ticks have fired, algo_state to check kill switch.',
    '- The scheduler only ever places PAPER orders — there is no live-money path through this surface. Don\'t imply otherwise.',
    '- algo_kill / algo_unkill are global. Use algo_kill when the user says "stop", "halt", "kill the algos" — confirm one-line afterwards. Don\'t auto-unkill; that\'s an explicit user action.',
    '- Don\'t generate or rewrite strategy code in chat unless the user asks. Send them to /algo/<id> to edit it themselves.',
    '',
    'Never invent symbols — ask if unsure. The lookup table below is authoritative for common names.',
    '',
    MOOMOO_RULES,
  ].join('\n')
}

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
  const ghostfolioTools = await getGhostfolioTools()
  const tools = { ...makeTools(client), ...ghostfolioTools }
  const modelMessages = await convertToModelMessages(
    body.messages as Parameters<typeof convertToModelMessages>[0],
  )

  const result = streamText({
    model: buildModel(),
    system: buildSystemPrompt(Object.keys(ghostfolioTools).length > 0),
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
