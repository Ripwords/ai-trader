import type { H3Event } from 'h3'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { inArray, sql } from 'drizzle-orm'

// Runs against a real, migrated Postgres. Point TEST_DATABASE_URL at a
// throwaway database: the suites delete every llm_providers row, so they share
// this file to run in sequence.
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

function makeEvent(headers: Record<string, string> = {}): H3Event {
  return { node: { req: { headers } }, context: {}, path: '/' } as unknown as H3Event
}

async function thrownStatus(promise: Promise<unknown>): Promise<number | undefined> {
  return promise.then(() => undefined, (err: { statusCode?: number }) => err.statusCode)
}

describe.skipIf(!url)('llm settings API (TEST_DATABASE_URL)', () => {
  let db: ReturnType<typeof import('../../db/client')['getDb']>
  let schema: typeof import('../../db/schema')
  let providers: typeof import('../../server/lib/llm-providers')
  let settings: typeof import('../../server/lib/llm-settings')

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    process.env.ENCRYPTION_KEY = 'test-encryption-key-for-db-suite'
    process.env.INTERNAL_BEARER = 'test-bearer'
    db = (await import('../../db/client')).getDb()
    schema = await import('../../db/schema')
    providers = await import('../../server/lib/llm-providers')
    settings = await import('../../server/lib/llm-settings')
  })

  beforeEach(async () => {
    await db.delete(schema.appSettings).where(inArray(schema.appSettings.key, ['llm']))
    await db.delete(schema.llmProviders)
  })

  const anthropic = { kind: 'anthropic' as const, label: 'Anthropic', baseUrl: null, apiKey: 'sk-ant-secret-9876' }

  it('lists providers with a hint and never the key', async () => {
    await providers.createProvider(anthropic)
    const handler = (await import('../../server/api/settings/llm/providers.get')).default
    const body = JSON.stringify(await handler(makeEvent()))
    expect(body).not.toContain('sk-ant-secret')
    expect(JSON.parse(body)).toEqual({
      providers: [expect.objectContaining({ kind: 'anthropic', label: 'Anthropic', baseUrl: null, apiKeyHint: '…9876' })],
    })
  })

  it('keeps the key when an update omits it, and refreshes the hint when it changes', async () => {
    const created = await providers.createProvider(anthropic)
    expect((await providers.updateProvider(created.id, { label: 'Work' }))?.apiKeyHint).toBe('…9876')
    expect((await providers.updateProvider(created.id, { apiKey: 'sk-ant-new-1111' }))?.apiKeyHint).toBe('…1111')
    expect((await providers.getProviderConnection(created.id))?.apiKey).toBe('sk-ant-new-1111')
  })

  it('returns null for an unknown provider', async () => {
    expect(await providers.updateProvider('00000000-0000-4000-8000-000000000000', { label: 'x' })).toBeNull()
    expect(await providers.deleteProvider('00000000-0000-4000-8000-000000000000')).toBe('not-found')
  })

  it('will not delete a provider the selection uses', async () => {
    const created = await providers.createProvider(anthropic)
    const other = await providers.createProvider({ ...anthropic, label: 'Spare' })
    await settings.saveLlmSettings({
      chat: { providerId: created.id, modelId: 'claude-sonnet-4-6' },
      quick: { providerId: created.id, modelId: 'claude-haiku-4-5-20251001' },
    })
    expect(await providers.deleteProvider(created.id)).toBe('in-use')
    expect(await providers.deleteProvider(other.id)).toBe('deleted')
  })

  it('rejects a selection that names a missing provider', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    expect(await thrownStatus(settings.saveLlmSettings({
      chat: { providerId: missing, modelId: 'm' },
      quick: { providerId: missing, modelId: 'm' },
    }))).toBe(400)
  })

  it('serves the decrypted runtime config to the api only behind the bearer', async () => {
    const handler = (await import('../../server/api/internal/llm-config.get')).default
    const created = await providers.createProvider(anthropic)
    const gateway = await providers.createProvider({ kind: 'openrouter', label: 'Gateway', baseUrl: 'https://gateway.example.com/v1', apiKey: 'or-key-4321' })

    expect(await thrownStatus(Promise.resolve().then(() => handler(makeEvent())))).toBe(401)
    const authed = makeEvent({ authorization: 'Bearer test-bearer' })
    expect(await thrownStatus(Promise.resolve().then(() => handler(authed)))).toBe(409)

    await settings.saveLlmSettings({
      chat: { providerId: created.id, modelId: 'claude-sonnet-4-6' },
      quick: { providerId: gateway.id, modelId: 'qwen/qwen3-32b' },
    })
    expect(await handler(authed)).toEqual({
      chat: { kind: 'anthropic', model_id: 'claude-sonnet-4-6', api_key: 'sk-ant-secret-9876', base_url: null },
      quick: { kind: 'openrouter', model_id: 'qwen/qwen3-32b', api_key: 'or-key-4321', base_url: 'https://gateway.example.com/v1' },
    })
  })
})
