import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  getHistorical: vi.fn().mockResolvedValue([
    {
      period: '2025',
      revenue: 130_497_000_000,
      net_income: 72_880_000_000,
      eps: null,
      fcf: 60_853_000_000,
      total_debt: 8_460_000_000,
      total_assets: 111_601_000_000,
      shareholders_equity: 79_327_000_000,
    },
    {
      period: '2024',
      revenue: 60_922_000_000,
      net_income: 29_760_000_000,
      eps: null,
      fcf: 27_021_000_000,
      total_debt: 9_700_000_000,
      total_assets: 65_728_000_000,
      shareholders_equity: 42_978_000_000,
    },
  ]),
  getQuarterlyHistory: vi.fn().mockResolvedValue([
    {
      period: '2026 Q1',
      end_date: '2026-04-30',
      revenue: 44_060_000_000,
      net_income: 18_780_000_000,
      eps: 0.81,
      operating_income: 21_640_000_000,
    },
  ]),
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
let yahoo: typeof import('../../server/lib/yahoo')
beforeEach(async () => {
  vi.resetModules()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/api/internal/yahoo/statement-history.get')
  handler = mod.default as Handler
  yahoo = await import('../../server/lib/yahoo')
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: { headers } }, context: {}, path } as unknown as H3Event
}

const auth = { authorization: 'Bearer test-bearer' }

describe('/internal/yahoo/statement-history', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('rejects missing symbol', async () => {
    await expect(handler(makeEvent(auth, {}))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects an invalid freq', async () => {
    await expect(
      handler(makeEvent(auth, { symbol: 'NVDA', freq: 'monthly' })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns annual history by default (5 periods)', async () => {
    const result = (await handler(makeEvent(auth, { symbol: 'NVDA' }))) as {
      symbol: string
      freq: string
      periods: { period: string; revenue: number | null }[]
    }
    expect(result.symbol).toBe('NVDA')
    expect(result.freq).toBe('annual')
    expect(result.periods[0].period).toBe('2025')
    expect(result.periods[0].revenue).toBe(130_497_000_000)
    expect(vi.mocked(yahoo.getHistorical)).toHaveBeenCalledWith('NVDA', 5)
  })

  it('returns quarterly history when freq=quarterly (8 periods default)', async () => {
    const result = (await handler(makeEvent(auth, { symbol: 'NVDA', freq: 'quarterly' }))) as {
      freq: string
      periods: { period: string; end_date: string; eps: number | null }[]
    }
    expect(result.freq).toBe('quarterly')
    expect(result.periods[0].end_date).toBe('2026-04-30')
    expect(result.periods[0].eps).toBe(0.81)
    expect(vi.mocked(yahoo.getQuarterlyHistory)).toHaveBeenCalledWith('NVDA', 8)
  })

  it('honors periods and caps it at 12', async () => {
    await handler(makeEvent(auth, { symbol: 'NVDA', freq: 'quarterly', periods: '20' }))
    expect(vi.mocked(yahoo.getQuarterlyHistory)).toHaveBeenCalledWith('NVDA', 12)

    await handler(makeEvent(auth, { symbol: 'AMD', freq: 'annual', periods: '3' }))
    expect(vi.mocked(yahoo.getHistorical)).toHaveBeenCalledWith('AMD', 3)
  })
})
