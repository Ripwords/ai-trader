import { describe, expect, it } from 'vitest'
import { PROVIDER_KINDS, providerCreateSchema, providerUpdateSchema } from '../../types/llm'

describe('provider request schemas', () => {
  it('accepts a keyed provider and trims its fields', () => {
    expect(providerCreateSchema.parse({ kind: 'anthropic', label: ' Work ', apiKey: ' sk-ant-1 ' })).toEqual({
      kind: 'anthropic', label: 'Work', baseUrl: null, apiKey: 'sk-ant-1',
    })
  })

  it('requires a key for every provider', () => {
    for (const kind of PROVIDER_KINDS) {
      const result = providerCreateSchema.safeParse({ kind, label: 'x' })
      expect(result.success, kind).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['apiKey'])
    }
  })

  it('offers online providers only', () => {
    expect(providerCreateSchema.safeParse({ kind: 'openai_compatible', label: 'Ollama', apiKey: 'k', baseUrl: 'http://ollama:11434/v1' }).success).toBe(false)
  })

  it('rejects a base URL that is not a URL and an empty key', () => {
    expect(providerCreateSchema.safeParse({ kind: 'openai', label: 'x', apiKey: 'k', baseUrl: 'not a url' }).success).toBe(false)
    expect(providerCreateSchema.safeParse({ kind: 'openai', label: 'x', apiKey: '  ' }).success).toBe(false)
  })

  it('treats omitted update fields as unchanged, a null base URL as the default, and never removes the key', () => {
    expect(providerUpdateSchema.parse({})).toEqual({})
    expect(providerUpdateSchema.parse({ baseUrl: null })).toEqual({ baseUrl: null })
    expect(providerUpdateSchema.safeParse({ apiKey: null }).success).toBe(false)
  })
})
