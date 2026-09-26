import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { appSettings, llmProviders } from '../../db/schema'
import { llmSettingsSchema, type LlmSettings, type ModelRole, type ProviderKind } from '../../types/llm'

export const LLM_SETTINGS_KEY = 'llm'

/** Everything needed to call a model. Holds the decrypted key: never send it to the browser. */
export interface ModelConfig {
  kind: ProviderKind
  modelId: string
  apiKey: string | null
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
