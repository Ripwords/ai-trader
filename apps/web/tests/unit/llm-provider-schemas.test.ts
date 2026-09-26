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
    expect(providerUpdateSchema.parse({ baseUrl: null, apiKey: 'k' })).toEqual({ baseUrl: null, apiKey: 'k' })
    expect(providerUpdateSchema.safeParse({ apiKey: null }).success).toBe(false)
  })

  it('requires the key again whenever an update changes the base URL, including back to the default', () => {
    for (const baseUrl of ['https://gateway.example.com/v1', null]) {
      const result = providerUpdateSchema.safeParse({ baseUrl })
      expect(result.success, String(baseUrl)).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['apiKey'])
    }
    expect(providerUpdateSchema.safeParse({ baseUrl: 'https://gateway.example.com/v1', apiKey: 'k' }).success).toBe(true)
  })

  it('accepts only https base URLs on public hosts', () => {
    const accepted = ['https://gateway.example.com/v1', 'https://openrouter.ai/api/v1', 'https://8.8.8.8/v1']
    const rejected = [
      'http://gateway.example.com/v1',
      'https://localhost/v1',
      'https://api.localhost/v1',
      'https://127.0.0.1/v1',
      'https://2130706433/v1',
      'https://10.1.2.3/v1',
      'https://172.20.0.5/v1',
      'https://192.168.1.10/v1',
      'https://169.254.169.254/latest',
      'https://100.64.0.1/v1',
      'https://0.0.0.0/v1',
      'https://[::1]/v1',
      'https://[fd00::1]/v1',
      'https://[fe80::1]/v1',
      'https://[::ffff:127.0.0.1]/v1',
      'https://api:8000/v1',
      'https://host.docker.internal/v1',
      'https://printer.local/v1',
      'https://gateway.example.com/v1?x=',
      'https://gateway.example.com/v1#frag',
      'https://user:pass@gateway.example.com/v1',
    ]
    for (const baseUrl of accepted) {
      expect(providerCreateSchema.safeParse({ kind: 'openai', label: 'x', apiKey: 'k', baseUrl }).success, baseUrl).toBe(true)
    }
    for (const baseUrl of rejected) {
      const result = providerCreateSchema.safeParse({ kind: 'openai', label: 'x', apiKey: 'k', baseUrl })
      expect(result.success, baseUrl).toBe(false)
      expect(result.error?.issues[0]?.path, baseUrl).toEqual(['baseUrl'])
    }
  })
})
