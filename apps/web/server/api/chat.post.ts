import { convertToModelMessages, stepCountIs, streamText } from 'ai'
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

export default defineEventHandler(async (event) => {
  const body = await readBody<{ messages?: unknown }>(event)
  if (!Array.isArray(body?.messages)) {
    throw createError({ statusCode: 400, statusMessage: 'messages must be an array' })
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

  return result.toUIMessageStreamResponse()
})
