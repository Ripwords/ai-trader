import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { appSettings, llmProviders } from '../../db/schema'
import { PROVIDER_KIND_META, type LlmSettings, type ProviderKind } from '../../types/llm'
import { keyHint, LLM_SETTINGS_KEY } from './llm-settings'

/**
 * One-time migration of the old env-based LLM config into llm_providers.
 * Delete this module once every deployment has booted it.
 */

const IMPORT_MARKER_KEY = 'llm_env_imported'
const LEGACY_DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6'

const ENV_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
} as const satisfies Partial<Record<ProviderKind, string>>
type EnvProviderKind = keyof typeof ENV_KEYS

// Mirrors the api's QUICK_FAMILY_FALLBACK, which picked the debate's quick
// model before the selection moved into the app.
const DEFAULT_QUICK_MODEL: Record<EnvProviderKind, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.5-flash',
  deepseek: 'deepseek-v4-flash',
}

interface EnvModelRef { kind: EnvProviderKind; modelId: string }

export interface EnvImportPlan {
  providers: Array<{ kind: EnvProviderKind; apiKey: string }>
  selection: { chat: EnvModelRef; quick: EnvModelRef } | null
}

type Env = Record<string, string | undefined>

function isEnvKind(value: string): value is EnvProviderKind {
  return value in ENV_KEYS
}

function parseSpec(spec: string | undefined): EnvModelRef | null {
  const slash = spec?.indexOf('/') ?? -1
  if (!spec || slash < 0) return null
  const kind = spec.slice(0, slash).trim()
  const modelId = spec.slice(slash + 1).trim()
  return isEnvKind(kind) && modelId ? { kind, modelId } : null
}

export function planEnvImport(env: Env): EnvImportPlan | null {
  const providers = (Object.keys(ENV_KEYS) as EnvProviderKind[]).flatMap((kind) => {
    const apiKey = env[ENV_KEYS[kind]]?.trim()
    // `.env.example` ships `sk-ant-...`-style placeholders for every provider.
    return apiKey && !apiKey.endsWith('...') ? [{ kind, apiKey }] : []
  })
  if (providers.length === 0) return null

  const hasKey = (ref: EnvModelRef | null): ref is EnvModelRef => !!ref && providers.some(p => p.kind === ref.kind)
  const chat = parseSpec(env.LLM_MODEL || LEGACY_DEFAULT_MODEL)
  if (!hasKey(chat)) return { providers, selection: null }
  const quickFromEnv = parseSpec(env.LLM_MODEL_QUICK)
  const quick = hasKey(quickFromEnv) ? quickFromEnv : { kind: chat.kind, modelId: DEFAULT_QUICK_MODEL[chat.kind] }
  return { providers, selection: { chat, quick } }
}

export type EnvImportOutcome = 'imported' | 'already-imported' | 'skipped' | 'nothing-to-import'

/**
 * Idempotent: a marker row records that the import ran, so providers the user
 * later deletes are not resurrected from a stale .env on the next boot.
 */
export async function importLlmEnvOnce(env: Env): Promise<EnvImportOutcome> {
  const { getOwnerId } = await import('../db/repo')
  const ownerId = await getOwnerId()
  return getDb().transaction(async (tx) => {
    const marker = await tx.select().from(appSettings).where(eq(appSettings.key, IMPORT_MARKER_KEY)).limit(1)
    if (marker.length > 0) return 'already-imported'

    const existing = await tx.select({ id: llmProviders.id }).from(llmProviders).limit(1)
    const plan = existing.length > 0 ? null : planEnvImport(env)
    const outcome: EnvImportOutcome = existing.length > 0 ? 'skipped' : plan ? 'imported' : 'nothing-to-import'

    if (plan) {
      const inserted = await tx
        .insert(llmProviders)
        .values(plan.providers.map(p => ({
          ownerId,
          kind: p.kind,
          label: PROVIDER_KIND_META[p.kind].label,
          apiKey: p.apiKey,
          apiKeyHint: keyHint(p.apiKey),
        })))
        .returning({ id: llmProviders.id, kind: llmProviders.kind })
      if (plan.selection) {
        const idFor = (kind: EnvProviderKind) => inserted.find(row => row.kind === kind)!.id
        const selection: LlmSettings = {
          chat: { providerId: idFor(plan.selection.chat.kind), modelId: plan.selection.chat.modelId },
          quick: { providerId: idFor(plan.selection.quick.kind), modelId: plan.selection.quick.modelId },
        }
        await tx.insert(appSettings).values({ key: LLM_SETTINGS_KEY, value: selection })
          .onConflictDoUpdate({ target: appSettings.key, set: { value: selection, updatedAt: new Date() } })
      }
    }
    await tx.insert(appSettings).values({ key: IMPORT_MARKER_KEY, value: { outcome, at: new Date().toISOString() } })
    return outcome
  })
}
