import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  getFinancialMetrics: vi.fn().mockResolvedValue({ symbol: 'AAPL', pe_ratio: 30, market_cap: 3e12 }),
  getHistorical: vi.fn().mockResolvedValue([{ period: '2024', fcf: 100 }]),
  getDailyBars: vi.fn().mockResolvedValue([{ time: '2024-01-02', open: 180, high: 182, low: 179, close: 181, volume: 1000000 }]),
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/api/internal/yahoo/valuation-inputs.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: { headers } }, context: {}, path } as unknown as H3Event
}

describe('/internal/yahoo/valuation-inputs', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'AAPL' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns 400 when symbol is missing', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, {})
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns symbol, metrics, history, dailyBars on valid request', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'AAPL' })
    const result = (await handler(event)) as {
      symbol: string
      metrics: { pe_ratio: number }
      history: Array<{ period: string }>
      dailyBars: Array<{ close: number }>
    }
    expect(result.symbol).toBe('AAPL')
    expect(result.metrics.pe_ratio).toBe(30)
    expect(Array.isArray(result.history)).toBe(true)
    expect(Array.isArray(result.dailyBars)).toBe(true)
    expect(result.history[0]?.period).toBe('2024')
    expect(result.dailyBars[0]?.close).toBe(181)
  })
})
