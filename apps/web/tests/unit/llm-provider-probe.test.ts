import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateText = vi.fn()
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => generateText(...args) }))
vi.mock('../../server/llm/model', () => ({ buildLanguageModel: (config: unknown) => ({ fake: config }) }))

const { listProviderModels, testProviderConnection } = await import('../../server/lib/llm-provider-probe')

type Call = { url: string; headers: Record<string, string> }
function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = []
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    return new Response(JSON.stringify(body), { status })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

beforeEach(() => {
  generateText.mockReset()
})

describe('listProviderModels', () => {
  it('lists OpenAI-protocol models with a bearer key at the default base URL', async () => {
    const f = fakeFetch(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })
    const models = await listProviderModels({ kind: 'openai', apiKey: 'sk-1', baseUrl: null }, f.impl)
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(f.calls[0]).toEqual({ url: 'https://api.openai.com/v1/models', headers: expect.objectContaining({ authorization: 'Bearer sk-1' }) })
  })

  it('honours an overridden base URL', async () => {
    const f = fakeFetch(200, { data: [{ id: 'qwen/qwen3-32b' }] })
    await listProviderModels({ kind: 'openrouter', apiKey: 'or-key', baseUrl: 'https://gateway.example.com/v1/' }, f.impl)
    expect(f.calls[0]!.url).toBe('https://gateway.example.com/v1/models')
  })

  it('uses Anthropic headers', async () => {
    const f = fakeFetch(200, { data: [{ id: 'claude-sonnet-4-6' }] })
    expect(await listProviderModels({ kind: 'anthropic', apiKey: 'sk-ant', baseUrl: null }, f.impl)).toEqual(['claude-sonnet-4-6'])
    expect(f.calls[0]!.headers).toEqual(expect.objectContaining({ 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' }))
  })

  it('lists only Gemini models that generate content, without the models/ prefix', async () => {
    const f = fakeFetch(200, { models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] })
    expect(await listProviderModels({ kind: 'google', apiKey: 'g-key', baseUrl: null }, f.impl)).toEqual(['gemini-2.5-pro'])
    expect(f.calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(f.calls[0]!.headers['x-goog-api-key']).toBe('g-key')
  })

  it('reports the provider error without echoing the key', async () => {
    const f = fakeFetch(401, { error: { message: 'Incorrect API key provided: sk-secret' } })
    const err = await listProviderModels({ kind: 'openai', apiKey: 'sk-secret', baseUrl: null }, f.impl).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('401')
    expect((err as Error).message).not.toContain('sk-secret')
  })
})

describe('testProviderConnection', () => {
  const config = { kind: 'openai' as const, apiKey: 'sk-1', baseUrl: null }

  it('pings the model when one is named and returns the model list', async () => {
    generateText.mockResolvedValue({ text: 'ok' })
    const f = fakeFetch(200, { data: [{ id: 'gpt-4o' }] })
    expect(await testProviderConnection(config, 'gpt-4o', f.impl)).toEqual({ ok: true, models: ['gpt-4o'] })
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({ model: { fake: { ...config, modelId: 'gpt-4o' } } }))
  })

  it('fails when the ping fails even if listing works', async () => {
    generateText.mockRejectedValue(new Error('model not found'))
    const f = fakeFetch(200, { data: [] })
    expect(await testProviderConnection(config, 'nope', f.impl)).toEqual({ ok: false, error: 'model not found' })
  })

  it('passes on a successful ping when the server cannot list models', async () => {
    generateText.mockResolvedValue({ text: 'ok' })
    const f = fakeFetch(404, {})
    expect(await testProviderConnection(config, 'gpt-4o', f.impl)).toEqual({ ok: true, models: [] })
  })

  it('without a model, the listing is the test', async () => {
    const f = fakeFetch(401, { error: { message: 'bad key' } })
    const result = await testProviderConnection(config, undefined, f.impl)
    expect(result.ok).toBe(false)
    expect(generateText).not.toHaveBeenCalled()
  })
})
