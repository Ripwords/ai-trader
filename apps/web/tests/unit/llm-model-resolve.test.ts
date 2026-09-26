import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelConfig } from '../../server/lib/llm-settings'

const factoryCalls: Array<{ factory: string; options: unknown; modelId: string; api: string }> = []

function fakeFactory(factory: string) {
  return (options: unknown) => {
    const provider = (modelId: string) => {
      factoryCalls.push({ factory, options, modelId, api: 'default' })
      return { factory, modelId }
    }
    provider.chat = (modelId: string) => {
      factoryCalls.push({ factory, options, modelId, api: 'chat' })
      return { factory, modelId }
    }
    return provider
  }
}

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: fakeFactory('anthropic') }))
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: fakeFactory('openai') }))
vi.mock('@ai-sdk/google', () => ({ createGoogleGenerativeAI: fakeFactory('google') }))
vi.mock('@ai-sdk/deepseek', () => ({ createDeepSeek: fakeFactory('deepseek') }))

const getModelConfig = vi.fn<(role: 'chat' | 'quick') => Promise<ModelConfig | null>>()
vi.mock('../../server/lib/llm-settings', () => ({ getModelConfig }))

const { buildLanguageModel, resolveModel, supportsForcedToolChoice } = await import('../../server/llm/model')

beforeEach(() => {
  factoryCalls.length = 0
  getModelConfig.mockReset()
})

describe('buildLanguageModel', () => {
  it.each([
    ['anthropic', 'anthropic', 'default'],
    ['openai', 'openai', 'default'],
    ['google', 'google', 'default'],
    ['deepseek', 'deepseek', 'default'],
  ] as const)('builds %s with its stored key and no base URL override', (kind, factory, api) => {
    buildLanguageModel({ kind, modelId: 'm-1', apiKey: 'sk-stored', baseUrl: null })
    expect(factoryCalls).toEqual([{ factory, options: { apiKey: 'sk-stored', baseURL: undefined }, modelId: 'm-1', api }])
  })

  it('passes a base URL override through to a native provider', () => {
    buildLanguageModel({ kind: 'anthropic', modelId: 'm', apiKey: 'k', baseUrl: 'https://proxy.example/v1' })
    expect(factoryCalls[0]!.options).toEqual({ apiKey: 'k', baseURL: 'https://proxy.example/v1' })
  })

  it('routes OpenRouter through the OpenAI chat-completions client at its default URL', () => {
    buildLanguageModel({ kind: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5', apiKey: 'or-key', baseUrl: null })
    expect(factoryCalls).toEqual([{
      factory: 'openai',
      options: { apiKey: 'or-key', baseURL: 'https://openrouter.ai/api/v1' },
      modelId: 'anthropic/claude-sonnet-4.5',
      api: 'chat',
    }])
  })

  it('points OpenRouter at an overridden base URL', () => {
    buildLanguageModel({ kind: 'openrouter', modelId: 'qwen/qwen3-32b', apiKey: 'or-key', baseUrl: 'https://gateway.example.com/v1' })
    expect(factoryCalls).toEqual([{
      factory: 'openai',
      options: { apiKey: 'or-key', baseURL: 'https://gateway.example.com/v1' },
      modelId: 'qwen/qwen3-32b',
      api: 'chat',
    }])
  })
})

describe('resolveModel', () => {
  it('builds the model for the requested role and reports its spec', async () => {
    getModelConfig.mockResolvedValue({ kind: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'sk-ds', baseUrl: null })
    const resolved = await resolveModel('quick')
    expect(getModelConfig).toHaveBeenCalledWith('quick')
    expect(resolved.spec).toBe('deepseek/deepseek-v4-flash')
    expect(resolved.providerKind).toBe('deepseek')
    expect(resolved.model).toEqual({ factory: 'deepseek', modelId: 'deepseek-v4-flash' })
  })

  it('fails with a typed llm_not_configured error when nothing is selected', async () => {
    getModelConfig.mockResolvedValue(null)
    await expect(resolveModel('chat')).rejects.toMatchObject({
      statusCode: 409,
      statusMessage: 'llm_not_configured',
      data: { code: 'llm_not_configured' },
    })
  })
})

/**
 * DeepSeek's thinking-mode models reject a forced `tool_choice` with a 400 that
 * kills the whole stream (verified against the live API 2026-09-05; every
 * model in GET /models behaves this way). The fallback is `tool_choice: "auto"`
 * plus the dispatch directive, which these models honour.
 */
describe('supportsForcedToolChoice', () => {
  it('allows forcing on non-reasoning providers', () => {
    expect(supportsForcedToolChoice({ providerKind: 'anthropic', modelId: 'claude-sonnet-4-6' })).toBe(true)
    expect(supportsForcedToolChoice({ providerKind: 'openai', modelId: 'gpt-4o' })).toBe(true)
    expect(supportsForcedToolChoice({ providerKind: 'google', modelId: 'gemini-2.5-pro' })).toBe(true)
  })

  it('refuses forcing on every DeepSeek model, known or not', () => {
    expect(supportsForcedToolChoice({ providerKind: 'deepseek', modelId: 'deepseek-v4-pro' })).toBe(false)
    expect(supportsForcedToolChoice({ providerKind: 'deepseek', modelId: 'deepseek-chat' })).toBe(false)
    expect(supportsForcedToolChoice({ providerKind: 'deepseek', modelId: 'deepseek-v5-whatever' })).toBe(false)
  })

  it('refuses forcing on a DeepSeek model reached through a gateway', () => {
    expect(supportsForcedToolChoice({ providerKind: 'openrouter', modelId: 'deepseek/deepseek-v4-pro' })).toBe(false)
  })
})
