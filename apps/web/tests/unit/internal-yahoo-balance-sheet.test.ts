import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  getFundamentalsBundle: vi.fn().mockResolvedValue({
    symbol: 'NVDA',
    balance_sheet: { total_assets: 1, total_liabilities: 1, total_equity: 0 },
  }),
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/internal/yahoo/balance-sheet.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return {
    node: { req: { headers } },
    context: {},
    path,
  } as unknown as H3Event
}

describe('/internal/yahoo/balance-sheet', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns balance sheet on bearer match', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as { symbol: string; balance_sheet: { total_assets: number } }
    expect(result.symbol).toBe('NVDA')
    expect(result.balance_sheet.total_assets).toBe(1)
  })
})
