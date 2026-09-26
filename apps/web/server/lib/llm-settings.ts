import { eq, inArray } from 'drizzle-orm'
import { createError } from 'h3'
import { getDb } from '../../db/client'
import { appSettings, llmProviders } from '../../db/schema'
import { llmSettingsSchema, type LlmSettings, type ModelRole, type ProviderKind } from '../../types/llm'

export const LLM_SETTINGS_KEY = 'llm'

/** Everything needed to call a model. Holds the decrypted key: never send it to the browser. */
export interface ModelConfig {
  kind: ProviderKind
  modelId: string
  apiKey: string
  baseUrl: string | null
}

export function keyHint(apiKey: string): string {
  return `…${apiKey.slice(-4)}`
}

export async function getLlmSettings(): Promise<LlmSettings | null> {
  const rows = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, LLM_SETTINGS_KEY))
    .limit(1)
  const parsed = llmSettingsSchema.safeParse(rows[0]?.value)
  return parsed.success ? parsed.data : null
}

export async function saveLlmSettings(selection: LlmSettings): Promise<void> {
  const ids = [...new Set([selection.chat.providerId, selection.quick.providerId])]
  const found = await getDb().select({ id: llmProviders.id }).from(llmProviders).where(inArray(llmProviders.id, ids))
  if (found.length !== ids.length) {
    throw createError({ statusCode: 400, statusMessage: 'The selected provider no longer exists.' })
  }
  await getDb()
    .insert(appSettings)
    .values({ key: LLM_SETTINGS_KEY, value: selection })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: selection, updatedAt: new Date() } })
}

export async function getModelConfig(role: ModelRole): Promise<ModelConfig | null> {
  const selection = await getLlmSettings()
  if (!selection) return null
  const ref = selection[role]
  const rows = await getDb()
    .select({ kind: llmProviders.kind, apiKey: llmProviders.apiKey, baseUrl: llmProviders.baseUrl })
    .from(llmProviders)
    .where(eq(llmProviders.id, ref.providerId))
    .limit(1)
  const provider = rows[0]
  if (!provider) return null
  return { ...provider, modelId: ref.modelId }
}
