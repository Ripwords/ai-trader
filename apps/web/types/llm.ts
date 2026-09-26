import { z } from 'zod'

export const PROVIDER_KINDS = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter', 'openai_compatible'] as const
export type ProviderKind = typeof PROVIDER_KINDS[number]

export interface ProviderKindMeta {
  label: string
  /** Where the SDK points when no override is stored. Null means the user must supply one. */
  defaultBaseUrl: string | null
  requiresKey: boolean
}

export const PROVIDER_KIND_META: Record<ProviderKind, ProviderKindMeta> = {
  anthropic: { label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1', requiresKey: true },
  openai: { label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', requiresKey: true },
  google: { label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', requiresKey: true },
  deepseek: { label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1', requiresKey: true },
  openrouter: { label: 'OpenRouter', defaultBaseUrl: 'https://openrouter.ai/api/v1', requiresKey: true },
  openai_compatible: { label: 'OpenAI-compatible (Ollama, LM Studio, ...)', defaultBaseUrl: null, requiresKey: false },
}

export type ModelRole = 'chat' | 'quick'

export const modelRefSchema = z.object({
  providerId: z.string().uuid(),
  modelId: z.string().trim().min(1).max(200),
})
export type ModelRef = z.infer<typeof modelRefSchema>

export const llmSettingsSchema = z.object({
  chat: modelRefSchema,
  quick: modelRefSchema,
})
export type LlmSettings = z.infer<typeof llmSettingsSchema>

/** A provider as the settings API exposes it: never the key itself. */
export interface LlmProviderView {
  id: string
  kind: ProviderKind
  label: string
  baseUrl: string | null
  /** `…abcd` when a key is stored, null when none is. */
  apiKeyHint: string | null
}
