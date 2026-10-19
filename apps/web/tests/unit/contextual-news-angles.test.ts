import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubNitroCache } from '../fixtures/nitro-cache'

const generateObjectMock = vi.fn()
vi.mock('ai', () => ({ generateObject: generateObjectMock }))
vi.mock('../../server/llm/model', () => ({
  resolveModel: async () => ({ model: {}, spec: 'anthropic/claude-haiku-4-5-20251001', providerKind: 'anthropic', modelId: 'claude-haiku-4-5-20251001' }),
}))
vi.mock('../../server/lib/llm-cost', () => ({ recordUsageSafely: vi.fn() }))
const promptOverrides = vi.hoisted(() => ({ value: {} as Record<string, string> }))
vi.mock('../../server/lib/prompts/store', () => ({ readPromptOverrides: async () => promptOverrides.value }))

let deriveAngles: typeof import('../../server/lib/contextual-news-angles')['deriveAngles']

beforeEach(async () => {
  vi.resetModules()
  generateObjectMock.mockReset()
  promptOverrides.value = {}
  stubNitroCache()
  ;({ deriveAngles } = await import('../../server/lib/contextual-news-angles'))
})

describe('deriveAngles', () => {
  it('sends the Settings override as the system prompt when one is saved', async () => {
    promptOverrides.value = { 'news.contextual_angles': 'CUSTOM ANGLES PROMPT' }
    generateObjectMock.mockResolvedValue({ object: { queries: ['q'] }, usage: undefined })
    await deriveAngles({ symbol: 'NVDA' })
    expect(generateObjectMock.mock.calls[0]![0].system).toBe('CUSTOM ANGLES PROMPT')
  })

  it('returns the model-derived queries, clamped to 4', async () => {
    generateObjectMock.mockResolvedValue({
      object: { queries: ['semis export controls', 'AMD AI demand', 'q3', 'q4', 'q5'] },
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    const out = await deriveAngles({ symbol: 'NVDA', companyName: 'NVIDIA Corp' })
    expect(out).toEqual({ queries: ['semis export controls', 'AMD AI demand', 'q3', 'q4'], failed: false })
  })

  it('drops empty/whitespace queries', async () => {
    generateObjectMock.mockResolvedValue({
      object: { queries: ['  ', 'real query', ''] },
      usage: undefined,
    })
    const out = await deriveAngles({ symbol: 'NVDA' })
    expect(out).toEqual({ queries: ['real query'], failed: false })
  })

  it('returns failed:true when the model call throws', async () => {
    generateObjectMock.mockRejectedValue(new Error('llm down'))
    const out = await deriveAngles({ symbol: 'NVDA' })
    expect(out).toEqual({ queries: [], failed: true })
  })

  it('reuses the angles for a repeat company but retries after a failure', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('rate limited'))
    generateObjectMock.mockResolvedValue({ object: { queries: ['q'] }, usage: undefined })

    expect((await deriveAngles({ symbol: 'NVDA' })).failed).toBe(true)
    expect(await deriveAngles({ symbol: 'NVDA' })).toEqual({ queries: ['q'], failed: false })
    await deriveAngles({ symbol: 'NVDA' })
    expect(generateObjectMock).toHaveBeenCalledTimes(2)
  })
})
