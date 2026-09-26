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

const PRIVATE_IPV4: Array<[number, number, number]> = [
  // [first octet, second-octet low, second-octet high]
  [0, 0, 255], [10, 0, 255], [100, 64, 127], [127, 0, 255], [169, 254, 254],
  [172, 16, 31], [192, 168, 168], [198, 18, 19],
]
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan']

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number)
  const [a, b] = octets as [number, number]
  return a >= 224 || PRIVATE_IPV4.some(([first, low, high]) => a === first && b >= low && b <= high)
}

/**
 * The server sends the stored key to this host and fetches from it, so it must
 * be a public HTTPS endpoint, not a service on the app's own network. IPv6
 * literals are refused outright. Checks the literal host only; a public name
 * that resolves to a private address still passes.
 */
export function baseUrlProblem(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return 'Enter a full URL, e.g. https://gateway.example.com/v1.'
  }
  if (url.protocol !== 'https:') return 'The base URL must use https://.'
  if (url.search || url.hash || url.username || url.password) {
    return 'The base URL cannot carry a query string, fragment or credentials.'
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const internal = host.startsWith('[')
    || (/^\d+\.\d+\.\d+\.\d+$/.test(host) && isPrivateIpv4(host))
    || !host.includes('.')
    || INTERNAL_SUFFIXES.some(suffix => host.endsWith(suffix))
  return internal ? 'The base URL must point at a public host, not a local or private address.' : null
}

const labelSchema = z.string().trim().min(1).max(64)
const baseUrlSchema = z.string().trim().max(500).superRefine((value, ctx) => {
  const problem = baseUrlProblem(value)
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
})
const apiKeySchema = z.string().trim().min(1, 'An API key is required.').max(500)
export const KEY_REQUIRED_FOR_BASE_URL = 'Re-enter the API key when you change the base URL.'

export const providerCreateSchema = z.object({
  kind: z.enum(PROVIDER_KINDS),
  label: labelSchema,
  baseUrl: baseUrlSchema.nullable().default(null),
  apiKey: apiKeySchema,
})
export type ProviderCreate = z.infer<typeof providerCreateSchema>

/**
 * Omitted fields stay as stored; `baseUrl: null` goes back to the default.
 * Send `baseUrl` only to change it, and then with the key: the stored key must
 * never follow the provider to a host it was not entered for.
 */
export const providerUpdateSchema = z.object({
  label: labelSchema.optional(),
  baseUrl: baseUrlSchema.nullable().optional(),
  apiKey: apiKeySchema.optional(),
}).superRefine((patch, ctx) => {
  if (patch.baseUrl !== undefined && patch.apiKey === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKey'], message: KEY_REQUIRED_FOR_BASE_URL })
  }
})
export type ProviderUpdate = z.infer<typeof providerUpdateSchema>

export const providerTestSchema = z.object({
  modelId: z.string().trim().min(1).max(200).optional(),
})

export type ProviderTestResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string }
