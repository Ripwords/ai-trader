import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  getFundamentalsBundle: vi.fn().mockResolvedValue({
    symbol: 'NVDA',
    cashflow: { period: '2024', free_cash_flow: 12345 },
  }),
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/api/internal/yahoo/cashflow.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: { headers } }, context: {}, path } as unknown as H3Event
}

describe('/internal/yahoo/cashflow', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns cashflow on bearer match', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as { symbol: string; cashflow: { free_cash_flow: number } }
    expect(result.symbol).toBe('NVDA')
    expect(result.cashflow.free_cash_flow).toBe(12345)
  })
})
