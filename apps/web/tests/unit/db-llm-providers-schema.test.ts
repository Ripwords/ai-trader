import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { llmProviderKind, llmProviders, llmUsage } from '../../db/schema'
import { PROVIDER_KINDS, llmSettingsSchema } from '../../types/llm'

const PROVIDER_ID = '4b6f2d1e-8a53-4c1b-9d7e-2f0a1b3c4d5e'

describe('llm_providers schema', () => {
  it('has the provider columns, with the key encrypted and a plaintext hint beside it', () => {
    const cols = getTableColumns(llmProviders)
    expect(Object.keys(cols)).toEqual(expect.arrayContaining([
      'id', 'ownerId', 'kind', 'label', 'baseUrl', 'apiKey', 'apiKeyHint', 'createdAt', 'updatedAt',
    ]))
    expect(cols.apiKey.notNull).toBe(true)
    expect(cols.apiKeyHint.notNull).toBe(true)
    expect(cols.baseUrl.notNull).toBe(false)
  })

  it('backs kind with a pg enum of every provider kind', () => {
    expect(llmProviderKind.enumValues).toEqual([...PROVIDER_KINDS])
  })

  it('lets usage rows record an unknown model with no cost', () => {
    expect(getTableColumns(llmUsage).estimatedCostUsd.notNull).toBe(false)
  })
})

describe('llmSettingsSchema', () => {
  it('parses a chat and quick model selection', () => {
    const parsed = llmSettingsSchema.parse({
      chat: { providerId: PROVIDER_ID, modelId: ' claude-sonnet-4-6 ' },
      quick: { providerId: PROVIDER_ID, modelId: 'claude-haiku-4-5' },
    })
    expect(parsed.chat.modelId).toBe('claude-sonnet-4-6')
  })

  it('rejects a selection missing a role or model id', () => {
    expect(llmSettingsSchema.safeParse({ chat: { providerId: PROVIDER_ID, modelId: 'x' } }).success).toBe(false)
    expect(llmSettingsSchema.safeParse({
      chat: { providerId: PROVIDER_ID, modelId: '' },
      quick: { providerId: PROVIDER_ID, modelId: 'x' },
    }).success).toBe(false)
  })
})
