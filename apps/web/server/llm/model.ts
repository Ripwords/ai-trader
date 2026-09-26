import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { createError } from 'h3'
import { PROVIDER_KIND_META, type ModelRole, type ProviderKind } from '../../types/llm'
import { getModelConfig, type ModelConfig } from '../lib/llm-settings'

export interface ResolvedModel {
  model: LanguageModel
  /** `<provider kind>/<model id>`: the key for pricing, context windows and usage rows. */
  spec: string
  providerKind: ProviderKind
  modelId: string
}

export interface ModelInfo {
  spec: string
  provider: ProviderKind
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

export function getModelInfo(model: Pick<ResolvedModel, 'spec' | 'providerKind' | 'modelId'>): ModelInfo {
  const envWindow = parsePositiveInt(process.env.LLM_CONTEXT_WINDOW)
  const knownWindow = KNOWN_CONTEXT_WINDOWS[model.spec]
  const outputReserve = parsePositiveInt(process.env.LLM_OUTPUT_RESERVE) ?? DEFAULT_OUTPUT_RESERVE

  return {
    spec: model.spec,
    provider: model.providerKind,
    modelId: model.modelId,
    contextWindow: envWindow ?? knownWindow ?? FALLBACK_CONTEXT_WINDOW,
    outputReserve,
    contextWindowSource: envWindow ? 'env' : knownWindow ? 'known' : 'fallback',
  }
}

export function modelSpec(kind: ProviderKind, modelId: string): string {
  return `${kind}/${modelId}`
}

export function buildLanguageModel(config: ModelConfig): LanguageModel {
  const apiKey = config.apiKey
  const baseURL = config.baseUrl ?? undefined
  switch (config.kind) {
    case 'anthropic':
      return createAnthropic({ apiKey, baseURL })(config.modelId)
    case 'openai':
      return createOpenAI({ apiKey, baseURL })(config.modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL })(config.modelId)
    case 'deepseek':
      return createDeepSeek({ apiKey, baseURL })(config.modelId)
    // OpenRouter speaks chat completions, not OpenAI's Responses API.
    case 'openrouter':
      return createOpenAI({ apiKey, baseURL: baseURL ?? PROVIDER_KIND_META.openrouter.defaultBaseUrl }).chat(config.modelId)
    default: {
      const unhandled: never = config.kind
      throw new Error(`Unhandled provider kind ${String(unhandled)}`)
    }
  }
}

export async function resolveModel(role: ModelRole): Promise<ResolvedModel> {
  const config = await getModelConfig(role)
  if (!config) {
    throw createError({
      statusCode: 409,
      statusMessage: 'llm_not_configured',
      message: 'No model provider is configured. Add one in Settings.',
      data: { code: 'llm_not_configured' },
    })
  }
  return {
    model: buildLanguageModel(config),
    spec: modelSpec(config.kind, config.modelId),
    providerKind: config.kind,
    modelId: config.modelId,
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
 * of them reject a forced tool_choice. The same models behind a gateway
 * (OpenRouter, a local proxy) behave the same, so the model id is checked too.
 *
 * The caller's fallback is `tool_choice: "auto"` plus the dispatch directive
 * naming the tool and its arguments, which these models do honour: the
 * dispatch survives, only its determinism is lost.
 */
export function supportsForcedToolChoice(model: Pick<ResolvedModel, 'providerKind' | 'modelId'>): boolean {
  return model.providerKind !== 'deepseek' && !model.modelId.toLowerCase().includes('deepseek')
}
