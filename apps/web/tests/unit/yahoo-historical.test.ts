import { beforeEach, describe, expect, it, vi } from 'vitest'

const quoteSummary = vi.fn()
const fundamentalsTimeSeries = vi.fn()

vi.mock('yahoo-finance2', () => ({
  default: class {
    quoteSummary = (...args: unknown[]) => quoteSummary(...args)
    fundamentalsTimeSeries = (...args: unknown[]) => fundamentalsTimeSeries(...args)
  },
}))

// Since late 2024 quoteSummary's statement modules carry revenue and net
// income only; the balance-sheet and cash-flow rows are stubs.
const STUB_SUMMARY = {
  incomeStatementHistory: {
    incomeStatementHistory: [
      { endDate: new Date('2025-09-27'), totalRevenue: 416.161e9, netIncome: 112.01e9 },
      { endDate: new Date('2024-09-28'), totalRevenue: 391.035e9, netIncome: 93.736e9 },
      { endDate: new Date('2023-09-30'), totalRevenue: 383.285e9, netIncome: 96.995e9 },
    ],
  },
  balanceSheetHistory: { balanceSheetStatements: [{ endDate: new Date('2025-09-27') }, { endDate: new Date('2024-09-28') }, { endDate: new Date('2023-09-30') }] },
  cashflowStatementHistory: { cashflowStatements: [{ endDate: new Date('2025-09-27') }, { endDate: new Date('2024-09-28') }, { endDate: new Date('2023-09-30') }] },
}

// fundamentalsTimeSeries returns oldest-first; capex is negative.
const BALANCE = [
  { date: new Date('2024-09-30'), totalDebt: 106.629e9, cashAndCashEquivalents: 29.943e9, totalAssets: 364.98e9, stockholdersEquity: 56.95e9 },
  { date: new Date('2025-09-30'), totalDebt: 98.657e9, cashAndCashEquivalents: 35.934e9, totalAssets: 359.241e9, stockholdersEquity: 73.733e9 },
]
const CASHFLOW = [
  { date: new Date('2024-09-30'), operatingCashFlow: 118.254e9, capitalExpenditure: -9.447e9 },
  { date: new Date('2025-09-30'), operatingCashFlow: 111.482e9, capitalExpenditure: -12.715e9 },
]

beforeEach(() => {
  vi.resetModules()
  quoteSummary.mockReset().mockResolvedValue(STUB_SUMMARY)
  fundamentalsTimeSeries.mockReset().mockImplementation(async (_sym: string, opts: { module: string }) =>
    opts.module === 'balance-sheet' ? BALANCE : CASHFLOW)
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
})

describe('getHistorical', () => {
  it('fills debt, cash, assets, equity and FCF from the annual time series', async () => {
    const { getHistorical } = await import('../../server/lib/yahoo')
    const [fy25] = await getHistorical('US.AAPL', 5)
    expect(fy25).toMatchObject({
      period: '2025',
      revenue: 416.161e9,
      total_debt: 98.657e9,
      cash: 35.934e9,
      total_assets: 359.241e9,
      shareholders_equity: 73.733e9,
    })
    expect(fy25?.fcf).toBeCloseTo(111.482e9 - 12.715e9, -3)
    expect(fundamentalsTimeSeries).toHaveBeenCalledWith('AAPL', expect.objectContaining({ type: 'annual', module: 'balance-sheet' }), expect.anything())
  })

  it('matches each fiscal year by its end date, not by position', async () => {
    const { getHistorical } = await import('../../server/lib/yahoo')
    const rows = await getHistorical('US.AAPL', 5)
    expect(rows.map(r => r.total_debt)).toEqual([98.657e9, 106.629e9, null])
    expect(rows[2]).toMatchObject({ period: '2023', revenue: 383.285e9, fcf: null, cash: null })
  })

  it('keeps revenue and net income when the time series fails', async () => {
    fundamentalsTimeSeries.mockRejectedValue(new Error('ETIMEDOUT'))
    const { getHistorical } = await import('../../server/lib/yahoo')
    const [fy25] = await getHistorical('US.AAPL', 5)
    expect(fy25).toMatchObject({ period: '2025', revenue: 416.161e9, net_income: 112.01e9, total_debt: null, fcf: null })
  })
})
