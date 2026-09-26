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

export interface ProviderIssue {
  path: 'baseUrl' | 'apiKey'
  message: string
}

/** Whether a provider, as it would be stored, can be called at all. */
export function providerIssue(kind: ProviderKind, baseUrl: string | null, hasKey: boolean): ProviderIssue | null {
  if (!baseUrl && PROVIDER_KIND_META[kind].defaultBaseUrl === null) {
    return { path: 'baseUrl', message: 'A base URL is required for this provider.' }
  }
  if (!hasKey && PROVIDER_KIND_META[kind].requiresKey) {
    return { path: 'apiKey', message: 'An API key is required for this provider.' }
  }
  return null
}

const labelSchema = z.string().trim().min(1).max(64)
const baseUrlSchema = z.string().trim().url().max(500)
const apiKeySchema = z.string().trim().min(1).max(500)

export const providerCreateSchema = z.object({
  kind: z.enum(PROVIDER_KINDS),
  label: labelSchema,
  baseUrl: baseUrlSchema.nullable().default(null),
  apiKey: apiKeySchema.nullable().default(null),
}).superRefine((input, ctx) => {
  const issue = providerIssue(input.kind, input.baseUrl, input.apiKey !== null)
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.path], message: issue.message })
})
export type ProviderCreate = z.infer<typeof providerCreateSchema>

/** Omitted fields stay as stored; `apiKey: null` removes the stored key. */
export const providerUpdateSchema = z.object({
  label: labelSchema.optional(),
  baseUrl: baseUrlSchema.nullable().optional(),
  apiKey: apiKeySchema.nullable().optional(),
})
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>

export const providerTestSchema = z.object({
  modelId: z.string().trim().min(1).max(200).optional(),
})

export type ProviderTestResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string }
