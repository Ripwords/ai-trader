import { beforeEach, describe, expect, it, vi } from 'vitest'

const fundamentalsTimeSeries = vi.fn()

vi.mock('yahoo-finance2', () => ({
  default: class {
    fundamentalsTimeSeries = (...args: unknown[]) => fundamentalsTimeSeries(...args)
  },
}))
vi.mock('../../server/lib/sec-edgar', () => ({ getSecQuarterlyOperatingIncome: vi.fn() }))

// Oldest-first, as Yahoo returns it; the first quarter has a date but no values.
const ROWS = [
  { date: new Date('2025-03-31') },
  { date: new Date('2025-06-30'), totalAssets: 330e9, totalDebt: 133.9e9, cashAndCashEquivalents: 57.7e9, stockholdersEquity: 333.8e9 },
  { date: new Date('2025-09-30'), totalAssets: 360e9, totalDebt: 135.4e9, cashAndCashEquivalents: 66.9e9, stockholdersEquity: 369.6e9 },
  { date: new Date('2025-12-31'), totalAssets: 400e9, totalDebt: 153.0e9, cashAndCashEquivalents: 86.8e9, stockholdersEquity: 411.1e9 },
  { date: new Date('2026-03-31'), totalAssets: 450e9, totalDebt: 209.9e9, cashAndCashEquivalents: 101.8e9, stockholdersEquity: 441.9e9 },
]

beforeEach(() => {
  vi.resetModules()
  fundamentalsTimeSeries.mockReset().mockResolvedValue(ROWS)
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
})

describe('getQuarterlyBalanceSheet', () => {
  it('returns quarters newest first from the quarterly time series, skipping empty rows', async () => {
    const { getQuarterlyBalanceSheet } = await import('../../server/lib/yahoo')
    const rows = await getQuarterlyBalanceSheet('US.AMZN', 8)
    expect(fundamentalsTimeSeries).toHaveBeenCalledWith('AMZN', expect.objectContaining({ type: 'quarterly', module: 'balance-sheet' }), expect.anything())
    expect(rows.map(r => r.end_date)).toEqual(['2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30'])
    expect(rows[0]).toEqual({
      period: '2026 Q1',
      end_date: '2026-03-31',
      total_assets: 450e9,
      total_debt: 209.9e9,
      cash: 101.8e9,
      shareholders_equity: 441.9e9,
    })
  })

  it('stops at the limit', async () => {
    const { getQuarterlyBalanceSheet } = await import('../../server/lib/yahoo')
    expect(await getQuarterlyBalanceSheet('US.AMZN', 2)).toHaveLength(2)
  })

  it('is empty when Yahoo fails', async () => {
    fundamentalsTimeSeries.mockRejectedValue(new Error('ETIMEDOUT'))
    const { getQuarterlyBalanceSheet } = await import('../../server/lib/yahoo')
    expect(await getQuarterlyBalanceSheet('US.AMZN', 8)).toEqual([])
  })
})
