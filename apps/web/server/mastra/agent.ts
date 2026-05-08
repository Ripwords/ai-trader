import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { Agent } from '@mastra/core/agent'
import { getApiClient } from './http'
import { MOOMOO_RULES } from './refs/moomoo-context'
import { makeMarketTools } from './tools/market'
import { makeSearchTools } from './tools/search'
import { makeTradeTools } from './tools/trade'
import { makeWatchlistTools } from './tools/watchlist'

let _agent: Agent | undefined

/**
 * Build a LanguageModel from an `LLM_MODEL` env string of the form
 * `"<provider>/<model-id>"`. Supports anthropic, openai, google, deepseek
 * (each with its own API key env var). One ai-sdk version per provider —
 * no npm aliases, so Nitro's prod-build tracer handles them cleanly.
 */
function buildModel(spec: string) {
  const slash = spec.indexOf('/')
  const provider = slash >= 0 ? spec.slice(0, slash) : 'anthropic'
  const modelId = slash >= 0 ? spec.slice(slash + 1) : spec

  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })(modelId)
    case 'openai':
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' })(modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '' })(modelId)
    case 'deepseek':
      return createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY ?? '' })(modelId)
    default:
      throw new Error(`Unknown LLM provider "${provider}" (LLM_MODEL=${spec}). Supported: anthropic, openai, google, deepseek.`)
  }
}

/**
 * Singleton Mastra Agent. Provider/model is selected via the LLM_MODEL env
 * var — see buildModel() above.
 */
export function getAgent(): Agent {
  if (_agent) return _agent

  const client = getApiClient()
  const marketTools = makeMarketTools(client)
  const watchlistTools = makeWatchlistTools(client)
  const searchTools = makeSearchTools(process.env.TAVILY_API_KEY ?? '')
  const tradeTools = makeTradeTools(client)

  const model = buildModel(process.env.LLM_MODEL || 'anthropic/claude-sonnet-4-6')

  _agent = new Agent({
    id: 'tradingCopilot',
    name: 'tradingCopilot',
    instructions: [
      'You are a trading copilot. The user has a moomoo OpenD account.',
      'When the user asks for a chart, ALWAYS call market.kline and present the result.',
      'When the user asks for a price, call market.snapshot.',
      'When the user wants to track a symbol, use watchlist.add. When they ask what they\'re tracking, use watchlist.list.',
      'For news / market context / company headlines, call search.news.',
      'For general facts or definitions, call search.web.',
      'For account/portfolio/orders/fills: call trade.accounts first to find acc_id, then trade.portfolio / trade.orders / trade.fills.',
      'Never invent symbols — ask if unsure. The lookup table below is authoritative for common names.',
      '',
      MOOMOO_RULES,
    ].join('\n'),
    model,
    tools: { ...marketTools, ...watchlistTools, ...searchTools, ...tradeTools },
  })

  return _agent
}
