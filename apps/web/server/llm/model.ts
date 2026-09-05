import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'

export const DEFAULT_MODEL_SPEC = 'anthropic/claude-sonnet-4-6'

export interface ModelInfo {
  spec: string
  provider: string
  modelId: string
  contextWindow: number
  outputReserve: number
  contextWindowSource: 'env' | 'known' | 'fallback'
}

const FALLBACK_CONTEXT_WINDOW = 128_000
const DEFAULT_OUTPUT_RESERVE = 8_000

const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  'anthropic/claude-sonnet-4-6': 200_000,
  'anthropic/claude-opus-4-7': 200_000,
  'openai/gpt-4o': 128_000,
  'openai/gpt-4o-mini': 128_000,
  'google/gemini-2.5-pro': 1_048_576,
  // Verified against the live API 2026-09-05 by sending oversized prompts:
  // v4-flash accepted a 400,084-token prompt outright. The previous 128_000
  // here was stale by more than 3x, so long chats were being trimmed to a
  // fraction of what the model can actually hold. 400_000 is the measured
  // floor, not an advertised ceiling — raise it if a larger prompt lands.
  'deepseek/deepseek-v4-pro': 400_000,
  'deepseek/deepseek-v4-flash': 400_000,
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

export function splitModelSpec(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf('/')
  if (slash < 0) {
    throw new Error(
      `LLM_MODEL must be "<provider>/<model-id>" (got "${spec}"). ` +
        `Examples: anthropic/claude-sonnet-4-6, openai/gpt-4o, ` +
        `google/gemini-2.5-pro, deepseek/deepseek-v4-flash.`,
    )
  }
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) }
}

export function getModelInfo(spec: string = process.env.LLM_MODEL || DEFAULT_MODEL_SPEC): ModelInfo {
  const { provider, modelId } = splitModelSpec(spec)
  const envWindow = parsePositiveInt(process.env.LLM_CONTEXT_WINDOW)
  const knownWindow = KNOWN_CONTEXT_WINDOWS[spec]
  const outputReserve = parsePositiveInt(process.env.LLM_OUTPUT_RESERVE) ?? DEFAULT_OUTPUT_RESERVE

  return {
    spec,
    provider,
    modelId,
    contextWindow: envWindow ?? knownWindow ?? FALLBACK_CONTEXT_WINDOW,
    outputReserve,
    contextWindowSource: envWindow ? 'env' : knownWindow ? 'known' : 'fallback',
  }
}

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
export function buildModel(spec: string = process.env.LLM_MODEL || DEFAULT_MODEL_SPEC) {
  const { provider, modelId } = splitModelSpec(spec)

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

/**
 * DeepSeek's whole current lineup runs in thinking mode, and thinking mode
 * rejects a forced `tool_choice` with a hard 400 ("Thinking mode does not
 * support this tool_choice") that aborts the entire stream — so every slash
 * command dies while plain chat still works.
 *
 * Verified against the live API 2026-09-05: `GET /models` lists only
 * deepseek-v4-pro, deepseek-v4-flash and deepseek-v4-flash-vision-exp, and all
 * of them reject a forced tool_choice. The non-thinking deepseek-chat alias
 * accepted it but is deprecated and no longer in the catalog, so there is no
 * DeepSeek model left to allowlist — the answer for this provider is always no.
 *
 * The caller's fallback is `tool_choice: "auto"` plus the dispatch directive
 * naming the tool and its arguments, which these models do honour: the
 * dispatch survives, only its determinism is lost.
 *
 * LLM_FORCE_TOOL_CHOICE=true forces anyway, for when DeepSeek ships a
 * non-thinking model again.
 */
export function supportsForcedToolChoice(
  spec: string = process.env.LLM_MODEL || DEFAULT_MODEL_SPEC,
): boolean {
  if (process.env.LLM_FORCE_TOOL_CHOICE === 'true') return true
  return splitModelSpec(spec).provider !== 'deepseek'
}
