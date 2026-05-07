import { Agent } from '@mastra/core/agent'
import { getApiClient } from './http'
import { makeMarketTools } from './tools/market'

let _agent: Agent | undefined

/**
 * Returns a singleton Mastra Agent configured with Claude and the market tools.
 *
 * Model is specified as a magic string "provider/model-id" which Mastra's
 * provider registry resolves at runtime (no @ai-sdk/anthropic required).
 *
 * ANTHROPIC_API_KEY is read automatically by Mastra from the environment;
 * we set it explicitly from runtimeConfig so it works in Nuxt's server context.
 */
export function getAgent(): Agent {
  if (_agent) return _agent

  const cfg = useRuntimeConfig()

  // Mastra reads ANTHROPIC_API_KEY from process.env.
  // Populate it from runtimeConfig if not already set.
  if (!process.env.ANTHROPIC_API_KEY && cfg.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = cfg.anthropicApiKey as string
  }

  const client = getApiClient()
  const tools = makeMarketTools(client)

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
    ].join('\n'),
    model,
    tools,
  })

  return _agent
}
