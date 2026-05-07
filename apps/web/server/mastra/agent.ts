import { Agent } from '@mastra/core/agent'
import { getApiClient } from './http'
import { makeMarketTools } from './tools/market'
import { makeWatchlistTools } from './tools/watchlist'

// Hydrate ANTHROPIC_API_KEY from runtimeConfig at module load — Mastra's
// provider registry reads process.env eagerly when the Agent is constructed.
// Fix A (docker-compose) propagates the key directly; this is a dev-mode safety net.
try {
  const _runtime = useRuntimeConfig()
  if (!process.env.ANTHROPIC_API_KEY && _runtime.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = _runtime.anthropicApiKey as string
  }
} catch {
  // useRuntimeConfig() may not be available outside a Nitro request context
  // in all environments. Fall back to Fix A (direct env propagation via compose).
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[mastra] ANTHROPIC_API_KEY not set — agent calls will fail')
  }
}

let _agent: Agent | undefined

/**
 * Returns a singleton Mastra Agent configured with Claude and the market tools.
 *
 * Model is specified as a magic string "provider/model-id" which Mastra's
 * provider registry resolves at runtime (no @ai-sdk/anthropic required).
 *
 * ANTHROPIC_API_KEY is propagated either via docker-compose (ANTHROPIC_API_KEY
 * env var) or from runtimeConfig at module load above.
 */
export function getAgent(): Agent {
  if (_agent) return _agent

  const cfg = useRuntimeConfig()
  const client = getApiClient()
  const marketTools = makeMarketTools(client)
  const watchlistTools = makeWatchlistTools(client)

  // llmModel in .env / runtimeConfig should be e.g. "claude-sonnet-4-6"
  // Mastra's router expects the "anthropic/model-id" prefix form.
  const rawModel = (cfg.llmModel as string) || 'claude-sonnet-4-6'
  const model = rawModel.startsWith('anthropic/')
    ? rawModel
    : `anthropic/${rawModel}`

  _agent = new Agent({
    name: 'tradingCopilot',
    instructions: [
      'You are a trading copilot. The user has a moomoo OpenD account.',
      'When the user asks for a chart, ALWAYS call market.kline and present the result.',
      'When the user asks for a price, call market.snapshot.',
      'Default markets: NVDA→US.NVDA, Tencent→HK.00700, Apple→US.AAPL, Tesla→US.TSLA, etc.',
      'Never invent symbols — ask if unsure.',
      'When the user wants to track a symbol, use watchlist.add. When they ask what they\'re tracking, use watchlist.list.',
    ].join('\n'),
    model,
    tools: { ...marketTools, ...watchlistTools },
  })

  return _agent
}
