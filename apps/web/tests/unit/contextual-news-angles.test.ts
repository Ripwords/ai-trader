import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateObjectMock = vi.fn()
vi.mock('ai', () => ({ generateObject: generateObjectMock }))
vi.mock('../../server/llm/model', () => ({ buildModel: () => ({}) }))
vi.mock('../../server/lib/llm-cost', () => ({ recordUsageSafely: vi.fn() }))

let deriveAngles: typeof import('../../server/lib/contextual-news-angles')['deriveAngles']

beforeEach(async () => {
  vi.resetModules()
  generateObjectMock.mockReset()
  process.env.LLM_MODEL = 'anthropic/claude-sonnet-4-6'
  ;({ deriveAngles } = await import('../../server/lib/contextual-news-angles'))
})

describe('deriveAngles', () => {
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
})
