import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  getFundamentalsBundle: vi.fn().mockResolvedValue({
    symbol: 'NVDA',
    metrics: { symbol: 'NVDA', pe_ratio: 50 },
    history: [],
    balance_sheet: null,
    cashflow: null,
    income_statement: null,
  }),
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/internal/yahoo/fundamentals.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: { headers } }, context: {}, path } as unknown as H3Event
}

describe('/internal/yahoo/fundamentals', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns full bundle on bearer match', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as { symbol: string; metrics: { pe_ratio: number } }
    expect(result.symbol).toBe('NVDA')
    expect(result.metrics.pe_ratio).toBe(50)
  })
})
