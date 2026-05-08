import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'

/**
 * Build a Vercel AI SDK LanguageModel from the LLM_MODEL env var,
 * which is a magic string `<provider>/<model-id>` — e.g.
 *   anthropic/claude-sonnet-4-6
 *   openai/gpt-4o
 *   google/gemini-2.5-pro
 *   deepseek/deepseek-v4-flash
 *
 * Each provider reads its API key from process.env (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, DEEPSEEK_API_KEY).
 */
export function buildModel(spec: string = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4-6') {
  const slash = spec.indexOf('/')
  if (slash < 0) {
    throw new Error(
      `LLM_MODEL must be "<provider>/<model-id>" (got "${spec}"). ` +
        `Examples: anthropic/claude-sonnet-4-6, openai/gpt-4o, ` +
        `google/gemini-2.5-pro, deepseek/deepseek-v4-flash.`,
    )
  }
  const provider = spec.slice(0, slash)
  const modelId = spec.slice(slash + 1)

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
      throw new Error(
        `Unknown LLM provider "${provider}" (LLM_MODEL=${spec}). Supported: anthropic, openai, google, deepseek.`,
      )
  }
}
