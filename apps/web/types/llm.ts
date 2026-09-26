import { z } from 'zod'

export const PROVIDER_KINDS = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter'] as const
export type ProviderKind = typeof PROVIDER_KINDS[number]

export interface ProviderKindMeta {
  label: string
  /** Where the SDK points when no override is stored. */
  defaultBaseUrl: string
}

export const PROVIDER_KIND_META: Record<ProviderKind, ProviderKindMeta> = {
  anthropic: { label: 'Anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1' },
  openai: { label: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1' },
  google: { label: 'Google Gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  deepseek: { label: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com/v1' },
  openrouter: { label: 'OpenRouter', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
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
  /** `…abcd`: the last four characters of the stored key. */
  apiKeyHint: string
}

const labelSchema = z.string().trim().min(1).max(64)
const baseUrlSchema = z.string().trim().url().max(500)
const apiKeySchema = z.string().trim().min(1, 'An API key is required.').max(500)

export const providerCreateSchema = z.object({
  kind: z.enum(PROVIDER_KINDS),
  label: labelSchema,
  baseUrl: baseUrlSchema.nullable().default(null),
  apiKey: apiKeySchema,
})
export type ProviderCreate = z.infer<typeof providerCreateSchema>

/** Omitted fields stay as stored; `baseUrl: null` goes back to the default. */
export const providerUpdateSchema = z.object({
  label: labelSchema.optional(),
  baseUrl: baseUrlSchema.nullable().optional(),
  apiKey: apiKeySchema.optional(),
})
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>

export const providerTestSchema = z.object({
  modelId: z.string().trim().min(1).max(200).optional(),
})

export type ProviderTestResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string }
