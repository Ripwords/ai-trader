import { describe, expect, it } from 'vitest'
import { providerCreateSchema, providerIssue, providerUpdateSchema } from '../../types/llm'

describe('provider request schemas', () => {
  it('accepts a keyed provider and trims its fields', () => {
    expect(providerCreateSchema.parse({ kind: 'anthropic', label: ' Work ', apiKey: ' sk-ant-1 ' })).toEqual({
      kind: 'anthropic', label: 'Work', baseUrl: null, apiKey: 'sk-ant-1',
    })
  })

  it('requires a key for hosted providers', () => {
    const result = providerCreateSchema.safeParse({ kind: 'openrouter', label: 'OR' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['apiKey'])
  })

  it('requires a base URL, but no key, for OpenAI-compatible servers', () => {
    const missing = providerCreateSchema.safeParse({ kind: 'openai_compatible', label: 'Ollama' })
    expect(missing.error?.issues[0]?.path).toEqual(['baseUrl'])
    expect(providerCreateSchema.safeParse({ kind: 'openai_compatible', label: 'Ollama', baseUrl: 'http://ollama:11434/v1' }).success).toBe(true)
  })

  it('rejects a base URL that is not a URL and an empty key', () => {
    expect(providerCreateSchema.safeParse({ kind: 'openai', label: 'x', apiKey: 'k', baseUrl: 'not a url' }).success).toBe(false)
    expect(providerCreateSchema.safeParse({ kind: 'openai', label: 'x', apiKey: '  ' }).success).toBe(false)
  })

  it('treats omitted update fields as unchanged and null as a removal', () => {
    expect(providerUpdateSchema.parse({})).toEqual({})
    expect(providerUpdateSchema.parse({ apiKey: null, baseUrl: null })).toEqual({ apiKey: null, baseUrl: null })
  })

  it('judges the merged state of an update', () => {
    expect(providerIssue('openai', null, true)).toBeNull()
    expect(providerIssue('openai', null, false)?.path).toBe('apiKey')
    expect(providerIssue('openai_compatible', null, false)?.path).toBe('baseUrl')
  })
})
