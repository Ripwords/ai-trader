import { generateText } from 'ai'
import { z } from 'zod'
import { PROVIDER_KIND_META, type ProviderKind, type ProviderTestResult } from '../../types/llm'
import { buildLanguageModel } from '../llm/model'
import type { ModelConfig } from './llm-settings'

export type ProviderConnection = Omit<ModelConfig, 'modelId'>

const TIMEOUT_MS = 15_000

interface ModelListing {
  headers: (apiKey: string) => Record<string, string>
  parse: (body: unknown) => string[]
}

const openAiListing: ModelListing = {
  headers: apiKey => ({ authorization: `Bearer ${apiKey}` }),
  parse: body => z.object({ data: z.array(z.object({ id: z.string() })) }).parse(body).data.map(m => m.id),
}

const LISTINGS: Record<ProviderKind, ModelListing> = {
  anthropic: {
    headers: apiKey => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
    parse: openAiListing.parse,
  },
  google: {
    headers: apiKey => ({ 'x-goog-api-key': apiKey }),
    parse: body => z
      .object({ models: z.array(z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()).default([]) })) })
      .parse(body)
      .models.filter(m => m.supportedGenerationMethods.includes('generateContent'))
      .map(m => m.name.replace(/^models\//, '')),
  },
  openai: openAiListing,
  deepseek: openAiListing,
  openrouter: openAiListing,
}

function redact(message: string, apiKey: string): string {
  const clean = message.split(apiKey).join('[key]')
  return clean.length > 300 ? `${clean.slice(0, 300)}…` : clean
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function listProviderModels(conn: ProviderConnection, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const baseUrl = conn.baseUrl ?? PROVIDER_KIND_META[conn.kind].defaultBaseUrl
  const listing = LISTINGS[conn.kind]
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
    headers: listing.headers(conn.apiKey),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(redact(`Listing models failed (${res.status}): ${detail}`, conn.apiKey))
  }
  return listing.parse(await res.json())
}

/**
 * With a model id, a one-token generation is the verdict and the model list is
 * a bonus: a proxy behind an overridden base URL may not serve /models. Without one, listing
 * models is the only check available.
 */
export async function testProviderConnection(
  conn: ProviderConnection,
  modelId: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const listing = listProviderModels(conn, fetchImpl)
  if (!modelId) {
    return listing.then(
      models => ({ ok: true as const, models }),
      (err: unknown) => ({ ok: false as const, error: redact(errorMessage(err), conn.apiKey) }),
    )
  }
  const models = listing.catch(() => [])
  try {
    await generateText({
      model: buildLanguageModel({ ...conn, modelId }),
      prompt: 'Reply with the word ok.',
      maxOutputTokens: 16,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }
  catch (err) {
    return { ok: false, error: redact(errorMessage(err), conn.apiKey) }
  }
  return { ok: true, models: await models }
}
