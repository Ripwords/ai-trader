import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  getFundamentalsBundle: vi.fn().mockResolvedValue({
    symbol: 'NVDA',
    history: [{ period: '2024' }],
    balance_sheet: { total_assets: 1, total_liabilities: 1, total_equity: 0 },
  }),
  getQuarterlyBalanceSheet: vi.fn().mockResolvedValue([
    { period: '2026 Q1', end_date: '2026-03-31', total_assets: 2, total_debt: 1, cash: 1, shareholders_equity: 1 },
  ]),
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  process.env.INTERNAL_BEARER = 'test-bearer-0123456789abcdef0123456789'
  const mod = await import('../../server/api/internal/yahoo/balance-sheet.get')
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
    const event = makeEvent({ authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as { symbol: string; balance_sheet: { total_assets: number } }
    expect(result.symbol).toBe('NVDA')
    expect(result.balance_sheet.total_assets).toBe(1)
  })

  it('returns the quarterly trend newest first', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }, { symbol: 'QTR' })
    const result = (await handler(event)) as { quarterly: { period: string }[] }
    expect(result.quarterly.map(r => r.period)).toEqual(['2026 Q1'])
  })

  it('still answers with the snapshot when the quarterly trend fails', async () => {
    const yahoo = await import('../../server/lib/yahoo')
    vi.mocked(yahoo.getQuarterlyBalanceSheet).mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const event = makeEvent({ authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }, { symbol: 'QFAIL' })
    const result = (await handler(event)) as { quarterly: unknown[], balance_sheet: unknown }
    expect(result.quarterly).toEqual([])
    expect(result.balance_sheet).not.toBeNull()
  })

  it('does not cache an empty bundle, so a failed Yahoo fetch is retried', async () => {
    const yahoo = await import('../../server/lib/yahoo')
    const bundle = vi.mocked(yahoo.getFundamentalsBundle)
    const calls = bundle.mock.calls.length
    bundle.mockResolvedValueOnce({ symbol: 'NVDA', history: [], balance_sheet: null } as Awaited<ReturnType<typeof yahoo.getFundamentalsBundle>>)
    const auth = { authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }
    await handler(makeEvent(auth, { symbol: 'NVDA' }))
    await handler(makeEvent(auth, { symbol: 'NVDA' }))
    expect(bundle.mock.calls.length - calls).toBe(2)
  })

  it('caches a bundle with history', async () => {
    const yahoo = await import('../../server/lib/yahoo')
    const bundle = vi.mocked(yahoo.getFundamentalsBundle)
    const calls = bundle.mock.calls.length
    const auth = { authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }
    await handler(makeEvent(auth, { symbol: 'CACHED' }))
    await handler(makeEvent(auth, { symbol: 'CACHED' }))
    expect(bundle.mock.calls.length - calls).toBe(1)
  })
})
