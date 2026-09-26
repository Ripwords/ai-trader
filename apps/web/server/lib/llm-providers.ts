import { asc, eq } from 'drizzle-orm'
import { createError } from 'h3'
import { getDb } from '../../db/client'
import { llmProviders } from '../../db/schema'
import { providerIssue, type LlmProviderView, type ProviderCreate, type ProviderUpdate } from '../../types/llm'
import { getLlmSettings, keyHint } from './llm-settings'
import type { ProviderConnection } from './llm-provider-probe'

const viewColumns = {
  id: llmProviders.id,
  kind: llmProviders.kind,
  label: llmProviders.label,
  baseUrl: llmProviders.baseUrl,
  apiKeyHint: llmProviders.apiKeyHint,
}

function assertUsable(...args: Parameters<typeof providerIssue>): void {
  const issue = providerIssue(...args)
  if (issue) throw createError({ statusCode: 400, statusMessage: issue.message, data: { path: issue.path } })
}

export async function listProviders(): Promise<LlmProviderView[]> {
  return getDb().select(viewColumns).from(llmProviders).orderBy(asc(llmProviders.createdAt))
}

export async function createProvider(input: ProviderCreate): Promise<LlmProviderView> {
  assertUsable(input.kind, input.baseUrl, input.apiKey !== null)
  const { getOwnerId } = await import('../db/repo')
  const [row] = await getDb()
    .insert(llmProviders)
    .values({
      ownerId: await getOwnerId(),
      kind: input.kind,
      label: input.label,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      apiKeyHint: input.apiKey === null ? null : keyHint(input.apiKey),
    })
    .returning(viewColumns)
  return row!
}

export async function updateProvider(id: string, patch: ProviderUpdate): Promise<LlmProviderView | null> {
  const [current] = await getDb().select(viewColumns).from(llmProviders).where(eq(llmProviders.id, id)).limit(1)
  if (!current) return null
  const baseUrl = patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl
  const hasKey = patch.apiKey === undefined ? current.apiKeyHint !== null : patch.apiKey !== null
  assertUsable(current.kind, baseUrl, hasKey)

  const [row] = await getDb()
    .update(llmProviders)
    .set({
      label: patch.label,
      baseUrl: patch.baseUrl,
      ...(patch.apiKey !== undefined && {
        apiKey: patch.apiKey,
        apiKeyHint: patch.apiKey === null ? null : keyHint(patch.apiKey),
      }),
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
