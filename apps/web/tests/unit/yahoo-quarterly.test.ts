import { beforeEach, describe, expect, it, vi } from 'vitest'

const quoteSummary = vi.fn()
const fundamentalsTimeSeries = vi.fn()
const getSecQuarterlyOperatingIncome = vi.fn()

vi.mock('yahoo-finance2', () => ({
  default: class {
    quoteSummary = (...args: unknown[]) => quoteSummary(...args)
    fundamentalsTimeSeries = (...args: unknown[]) => fundamentalsTimeSeries(...args)
  },
}))
vi.mock('../../server/lib/sec-edgar', () => ({
  getSecQuarterlyOperatingIncome: (s: string) => getSecQuarterlyOperatingIncome(s),
}))

// quoteSummary's quarterly income rows no longer carry operatingIncome.
const SUMMARY = {
  incomeStatementHistoryQuarterly: {
    incomeStatementHistory: [
      { endDate: new Date('2026-09-30'), totalRevenue: 201.944e9, netIncome: 20.685e9 },
      { endDate: new Date('2026-06-30'), totalRevenue: 200.606e9, netIncome: 62.647e9 },
      { endDate: new Date('2026-03-31'), totalRevenue: 181.519e9, netIncome: 30.255e9 },
    ],
  },
  earningsHistory: { history: [] },
}

beforeEach(() => {
  vi.resetModules()
  quoteSummary.mockReset().mockResolvedValue(SUMMARY)
  // Yahoo's quarterly series lags: the newest two quarters are empty rows.
  fundamentalsTimeSeries.mockReset().mockResolvedValue([
    { date: new Date('2026-03-31'), operatingIncome: 23.852e9 },
    { date: new Date('2026-06-30') },
    { date: new Date('2026-09-30') },
  ])
  getSecQuarterlyOperatingIncome.mockReset().mockResolvedValue([
    { end: '2026-06-30', val: 19.2e9 },
    { end: '2026-09-30', val: 17.4e9 },
  ])
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
})

describe('getQuarterlyHistory operating income', () => {
  it('takes operating income from SEC filings, then from the Yahoo series', async () => {
    const { getQuarterlyHistory } = await import('../../server/lib/yahoo')
    const rows = await getQuarterlyHistory('US.AMZN', 8)
    expect(rows.map(r => [r.end_date, r.operating_income])).toEqual([
      ['2026-09-30', 17.4e9],
      ['2026-06-30', 19.2e9],
      ['2026-03-31', 23.852e9],
    ])
    // Net income stays as reported, so a one-off gain shows as the gap.
    expect(rows[1]?.net_income).toBe(62.647e9)
  })

  it('still returns the quarters when SEC and the series both fail', async () => {
    getSecQuarterlyOperatingIncome.mockRejectedValue(new Error('ETIMEDOUT'))
    fundamentalsTimeSeries.mockRejectedValue(new Error('ETIMEDOUT'))
    const { getQuarterlyHistory } = await import('../../server/lib/yahoo')
    const rows = await getQuarterlyHistory('US.AMZN', 8)
    expect(rows.map(r => r.operating_income)).toEqual([null, null, null])
    expect(rows[0]?.revenue).toBe(201.944e9)
  })

  it('extends the history with older quarters from the Yahoo series, newest first', async () => {
    fundamentalsTimeSeries.mockResolvedValue([
      { date: new Date('2025-06-30'), totalRevenue: 167.702e9, netIncome: 18.164e9, operatingIncome: 19.171e9 },
      { date: new Date('2025-09-30'), totalRevenue: 180.169e9, netIncome: 21.187e9, operatingIncome: 17.422e9 },
      { date: new Date('2025-12-31'), totalRevenue: 213.386e9, netIncome: 21.192e9, operatingIncome: 24.977e9 },
      { date: new Date('2026-03-31'), totalRevenue: 181.519e9, netIncome: 30.255e9, operatingIncome: 23.852e9 },
      { date: new Date('2026-06-30') },
      { date: new Date('2026-09-30') },
    ])
    const { getQuarterlyHistory } = await import('../../server/lib/yahoo')
    const rows = await getQuarterlyHistory('US.AMZN', 8)
    expect(rows.map(r => r.end_date)).toEqual(['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30'])
    expect(rows[4]).toMatchObject({ period: '2025 Q3', revenue: 180.169e9, net_income: 21.187e9, operating_income: 17.422e9, eps: null })
  })

  it('stops at the requested number of quarters', async () => {
    fundamentalsTimeSeries.mockResolvedValue([
      { date: new Date('2025-09-30'), totalRevenue: 180.169e9 },
      { date: new Date('2025-12-31'), totalRevenue: 213.386e9 },
    ])
    const { getQuarterlyHistory } = await import('../../server/lib/yahoo')
    expect((await getQuarterlyHistory('US.AMZN', 4)).map(r => r.end_date)).toEqual(['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31'])
  })
})
