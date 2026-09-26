import { asc, eq } from 'drizzle-orm'
import { createError } from 'h3'
import { getDb } from '../../db/client'
import { llmProviders } from '../../db/schema'
import { KEY_REQUIRED_FOR_BASE_URL, type LlmProviderView, type ProviderCreate, type ProviderUpdate } from '../../types/llm'
import { getLlmSettings, keyHint } from './llm-settings'
import type { ProviderConnection } from './llm-provider-probe'

const viewColumns = {
  id: llmProviders.id,
  kind: llmProviders.kind,
  label: llmProviders.label,
  baseUrl: llmProviders.baseUrl,
  apiKeyHint: llmProviders.apiKeyHint,
}

export async function listProviders(): Promise<LlmProviderView[]> {
  return getDb().select(viewColumns).from(llmProviders).orderBy(asc(llmProviders.createdAt))
}

export async function createProvider(input: ProviderCreate): Promise<LlmProviderView> {
  const { getOwnerId } = await import('../db/repo')
  const [row] = await getDb()
    .insert(llmProviders)
    .values({
      ownerId: await getOwnerId(),
      kind: input.kind,
      label: input.label,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      apiKeyHint: keyHint(input.apiKey),
    })
    .returning(viewColumns)
  return row!
}

export async function updateProvider(id: string, patch: ProviderUpdate): Promise<LlmProviderView | null> {
  const [current] = await getDb().select(viewColumns).from(llmProviders).where(eq(llmProviders.id, id)).limit(1)
  if (!current) return null
  if (patch.baseUrl !== undefined && patch.baseUrl !== current.baseUrl && patch.apiKey === undefined) {
    throw createError({ statusCode: 400, statusMessage: KEY_REQUIRED_FOR_BASE_URL })
  }
  const [row] = await getDb()
    .update(llmProviders)
    .set({
      label: patch.label,
      baseUrl: patch.baseUrl,
      ...(patch.apiKey !== undefined && { apiKey: patch.apiKey, apiKeyHint: keyHint(patch.apiKey) }),
      updatedAt: new Date(),
    })
    .where(eq(llmProviders.id, id))
    .returning(viewColumns)
  return row ?? null
}

export async function deleteProvider(id: string): Promise<'deleted' | 'not-found' | 'in-use'> {
  const selection = await getLlmSettings()
  if (selection && (selection.chat.providerId === id || selection.quick.providerId === id)) return 'in-use'
  const deleted = await getDb().delete(llmProviders).where(eq(llmProviders.id, id)).returning({ id: llmProviders.id })
  return deleted.length > 0 ? 'deleted' : 'not-found'
}

/** Decrypts the key: for server-side calls only. */
export async function getProviderConnection(id: string): Promise<ProviderConnection | null> {
  const [row] = await getDb()
    .select({ kind: llmProviders.kind, apiKey: llmProviders.apiKey, baseUrl: llmProviders.baseUrl })
    .from(llmProviders)
    .where(eq(llmProviders.id, id))
    .limit(1)
  return row ?? null
}
