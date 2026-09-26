import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { inArray, sql } from 'drizzle-orm'

// Runs against a real, migrated Postgres. Point TEST_DATABASE_URL at a
// throwaway database: the suite deletes every llm_providers row.
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('llm settings persistence (TEST_DATABASE_URL)', () => {
  let db: ReturnType<typeof import('../../db/client')['getDb']>
  let schema: typeof import('../../db/schema')
  let settings: typeof import('../../server/lib/llm-settings')
  let envImport: typeof import('../../server/lib/llm-env-import')

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    process.env.ENCRYPTION_KEY = 'test-encryption-key-for-db-suite'
    db = (await import('../../db/client')).getDb()
    schema = await import('../../db/schema')
    settings = await import('../../server/lib/llm-settings')
    envImport = await import('../../server/lib/llm-env-import')
  })

  beforeEach(async () => {
    await db.delete(schema.llmProviders)
    await db.delete(schema.appSettings).where(inArray(schema.appSettings.key, ['llm', 'llm_env_imported']))
  })

  const env = { LLM_MODEL: 'anthropic/claude-sonnet-4-6', ANTHROPIC_API_KEY: 'sk-ant-live-1234' }

  it('imports env once, stores the key encrypted, and resolves it back', async () => {
    expect(await envImport.importLlmEnvOnce(env)).toBe('imported')
    expect(await envImport.importLlmEnvOnce(env)).toBe('already-imported')

    const rows = await db.execute(sql`select api_key, api_key_hint from llm_providers`)
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]!.api_key).not.toContain('sk-ant-live-1234')
    expect(rows.rows[0]!.api_key_hint).toBe('…1234')

    expect(await settings.getModelConfig('chat')).toEqual({
      kind: 'anthropic', modelId: 'claude-sonnet-4-6', apiKey: 'sk-ant-live-1234', baseUrl: null,
    })
    expect((await settings.getModelConfig('quick'))?.modelId).toBe('claude-haiku-4-5-20251001')
  })

  it('does not resurrect providers the user deleted after the import', async () => {
    await envImport.importLlmEnvOnce(env)
    await db.delete(schema.llmProviders)
    expect(await envImport.importLlmEnvOnce(env)).toBe('already-imported')
    expect(await db.select().from(schema.llmProviders)).toHaveLength(0)
  })

  it('leaves providers configured in the app alone', async () => {
    const ownerId = await (await import('../../server/db/repo')).getOwnerId()
    await db.insert(schema.llmProviders).values({ ownerId, kind: 'openai', label: 'Mine', apiKey: 'sk-mine', apiKeyHint: '…mine' })
    expect(await envImport.importLlmEnvOnce(env)).toBe('skipped')
    expect(await db.select().from(schema.llmProviders)).toHaveLength(1)
  })

  it('reports nothing configured when no selection exists', async () => {
    expect(await settings.getModelConfig('chat')).toBeNull()
  })
})
