import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: vi.fn(async (s: string) => s.includes('NVDA') ? { status: 'resolved', symbol: 'US.NVDA', name: 'NVIDIA' } : { status: 'not_found' }),
  getFinancialMetrics: vi.fn(async () => ({ pe: 30 })),
}))
vi.mock('../../server/lib/contextual-news', () => ({ getContextualNews: vi.fn(async () => ({ ticker: [] })) }))

let gatherDypContext: typeof import('../../server/llm/research/dyp')['gatherDypContext']
beforeEach(async () => {
  vi.clearAllMocks()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
    ({ ok: true, json: async () => ({ fair_value: 100 }) }) as unknown as Response) as unknown as typeof fetch
  gatherDypContext = (await import('../../server/llm/research/dyp')).gatherDypContext
})

describe('gatherDypContext', () => {
  it('extracts a ticker from the question and attaches a context bundle', async () => {
    const c = await gatherDypContext({ question: 'where is NVDA moat?', baseUrl: 'http://x' })
    expect(c.symbol).toBe('US.NVDA')
    expect(c.companyName).toBe('NVIDIA')
    expect(c.fundamentals).not.toBeNull()
    expect(c.valuation).not.toBeNull()
  })
  it('returns nulls when no ticker is present (pure-reasoning path)', async () => {
    const c = await gatherDypContext({ question: 'is moat investing dead?', baseUrl: 'http://x' })
    expect(c.symbol).toBeNull()
    expect(c.fundamentals).toBeNull()
  })
})
