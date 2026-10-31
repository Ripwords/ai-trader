import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  getFundamentalsBundle: vi.fn().mockResolvedValue({
    symbol: 'NVDA',
    history: [{ period: '2024' }],
    cashflow: { period: '2024', free_cash_flow: 12345 },
    metrics: { free_cash_flow: 3219124992 },
  }),
}))
const getCashflowSeries = vi.fn()
vi.mock('../../server/lib/cashflow-series', () => ({ getCashflowSeries: (s: string) => getCashflowSeries(s) }))

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  getCashflowSeries.mockReset()
  getCashflowSeries.mockResolvedValue({ source: 'SEC EDGAR XBRL company facts (10-Q/10-K)', ttm: { label: 'TTM to 2026-09-30', fcf: -46.892e9 } })
  process.env.INTERNAL_BEARER = 'test-bearer-0123456789abcdef0123456789'
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
    const event = makeEvent({ authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as { symbol: string; cashflow: { free_cash_flow: number } }
    expect(result.symbol).toBe('NVDA')
    expect(result.cashflow.free_cash_flow).toBe(12345)
  })

  it('adds the labelled OCF − capex series and the Yahoo levered FCF, each with its definition', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }, { symbol: 'AMZN' })
    const result = (await handler(event)) as {
      series: { ttm: { label: string; fcf: number } }
      yahoo_levered_fcf: { value: number; definition: string }
    }
    expect(result.series.ttm).toEqual({ label: 'TTM to 2026-09-30', fcf: -46.892e9 })
    expect(result.yahoo_levered_fcf.value).toBe(3219124992)
    expect(result.yahoo_levered_fcf.definition).toMatch(/levered/i)
  })

  it('keeps the old payload when the series lookup fails', async () => {
    getCashflowSeries.mockRejectedValue(new Error('down'))
    const event = makeEvent({ authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as { cashflow: { free_cash_flow: number }; series: unknown }
    expect(result.cashflow.free_cash_flow).toBe(12345)
    expect(result.series).toBeNull()
  })

  it('does not cache a failed series, so the next call retries it', async () => {
    getCashflowSeries.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const auth = { authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }
    expect(((await handler(makeEvent(auth, { symbol: 'AMZN' }))) as { series: unknown }).series).toBeNull()
    const again = (await handler(makeEvent(auth, { symbol: 'AMZN' }))) as { series: { ttm: { fcf: number } } }
    expect(again.series.ttm.fcf).toBe(-46.892e9)
    expect(getCashflowSeries).toHaveBeenCalledTimes(2)
  })

  it('does not cache an empty bundle, so a failed Yahoo fetch is retried', async () => {
    const yahoo = await import('../../server/lib/yahoo')
    const bundle = vi.mocked(yahoo.getFundamentalsBundle)
    const calls = bundle.mock.calls.length
    bundle.mockResolvedValueOnce({ symbol: 'NVDA', history: [], cashflow: null } as Awaited<ReturnType<typeof yahoo.getFundamentalsBundle>>)
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
