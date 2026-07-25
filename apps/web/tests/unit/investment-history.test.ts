import { describe, expect, it } from 'vitest'
import {
  buildInvestmentSnapshotRow,
  computeInvestmentPerformance,
  withDeadline,
  type InvestmentEquityPoint,
} from '../../server/lib/investment-history'
import type { InvestmentPortfolio } from '../../server/lib/investment-portfolio'

function portfolio(over: Partial<InvestmentPortfolio> = {}): InvestmentPortfolio {
  return {
    source: 'moomoo_live',
    status: 'ok',
    as_of: '2026-07-25T01:00:00.000Z',
    accounts: ['281'],
    reporting_currency: 'MYR',
    positions: [],
    by_currency: [
      { currency: 'USD', market_value: 6900, day_change_value: -228, day_change_pct: -3.2, unrealized_pl: 1300 },
    ],
    total_market_value_reporting: 62_654,
    total_day_change_reporting: -1364,
    total_day_change_pct: -2.13,
    total_unrealized_pl_reporting: 9_580,
    total_cost_basis_reporting: 53_074,
    cash_by_currency: { USD: 1634.12 },
    caveats: [],
    ...over,
  }
}

function point(over: Partial<InvestmentEquityPoint> & { t: string; marketValue: number }): InvestmentEquityPoint {
  return {
    source: 'auto',
    currency: 'MYR',
    costBasis: 100,
    unrealizedPl: 0,
    dayChange: null,
    dayChangePct: null,
    ...over,
  }
}

const DAY = 24 * 60 * 60 * 1000
function at(daysAgo: number): string {
  // Fixed epoch so the tests never depend on wall-clock time.
  return new Date(Date.parse('2026-07-25T00:00:00.000Z') - daysAgo * DAY).toISOString()
}

describe('buildInvestmentSnapshotRow', () => {
  it('maps an ok portfolio into the stored row shape', () => {
    const row = buildInvestmentSnapshotRow(portfolio())
    expect(row.reportingCurrency).toBe('MYR')
    expect(row.marketValue).toBeCloseTo(62_654, 2)
    expect(row.costBasis).toBeCloseTo(53_074, 2)
    expect(row.unrealizedPl).toBeCloseTo(9_580, 2)
    expect(row.dayChange).toBeCloseTo(-1364, 2)
    expect(row.dayChangePct).toBeCloseTo(-2.13, 4)
    expect(row.accounts).toEqual(['281'])
  })

  it('refuses to record a snapshot when the investments layer is unavailable', () => {
    expect(() => buildInvestmentSnapshotRow(portfolio({
      status: 'unavailable',
      total_market_value_reporting: null,
    }))).toThrow(/unavailable/i)
  })

  it('refuses to record a snapshot when FX left the total unknown', () => {
    // A null total would otherwise be stored as 0 and read back as a crash to zero.
    expect(() => buildInvestmentSnapshotRow(portfolio({
      total_market_value_reporting: null,
    }))).toThrow(/total/i)
  })

  it('records a no_positions portfolio as a genuine zero', () => {
    const row = buildInvestmentSnapshotRow(portfolio({
      status: 'no_positions',
      positions: [],
      by_currency: [],
      total_market_value_reporting: 0,
      total_cost_basis_reporting: 0,
      total_unrealized_pl_reporting: 0,
      total_day_change_reporting: 0,
      total_day_change_pct: 0,
    }))
    expect(row.marketValue).toBe(0)
  })
})

describe('withDeadline', () => {
  it('passes through a value that arrives in time', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 1000, 'read')).resolves.toBe('ok')
  })

  it('rejects with a named timeout when the read stalls', async () => {
    // moomoo OpenD being down makes the underlying HTTP call hang with no
    // client timeout, which would otherwise stall the daily capture cron.
    const never = new Promise<string>(() => {})
    await expect(withDeadline(never, 10, 'investments read')).rejects.toThrow(/investments read.*10ms/i)
  })

  it('propagates the original error rather than masking it as a timeout', async () => {
    const boom = Promise.reject(new Error('opend refused'))
    await expect(withDeadline(boom, 1000, 'read')).rejects.toThrow('opend refused')
  })
})

describe('computeInvestmentPerformance', () => {
  it('returns empty stats with no snapshots', () => {
    const { series, stats } = computeInvestmentPerformance([])
    expect(series).toEqual([])
    expect(stats.count).toBe(0)
    expect(stats.valueChangePct).toBeNull()
    expect(stats.maxDrawdownPct).toBeNull()
  })

  it('orders points chronologically and reports value change', () => {
    const { series, stats } = computeInvestmentPerformance([
      point({ t: at(0), marketValue: 110, costBasis: 100 }),
      point({ t: at(10), marketValue: 100, costBasis: 100 }),
    ])
    expect(series.map(p => p.t)).toEqual([at(10), at(0)])
    expect(stats.count).toBe(2)
    expect(stats.valueChangePct).toBeCloseTo(10, 6)
    expect(stats.currency).toBe('MYR')
  })

  it('computes max drawdown peak-to-trough', () => {
    const { stats } = computeInvestmentPerformance([
      point({ t: at(3), marketValue: 100 }),
      point({ t: at(2), marketValue: 120 }),
      point({ t: at(1), marketValue: 90 }),
      point({ t: at(0), marketValue: 110 }),
    ])
    // 90 vs the 120 peak
    expect(stats.maxDrawdownPct).toBeCloseTo(-25, 6)
  })

  it('reports 1/7/30-day returns against the nearest older snapshot', () => {
    const { stats } = computeInvestmentPerformance([
      point({ t: at(30), marketValue: 100 }),
      point({ t: at(7), marketValue: 200 }),
      point({ t: at(1), marketValue: 400 }),
      point({ t: at(0), marketValue: 440 }),
    ])
    expect(stats.periodReturns.d1).toBeCloseTo(10, 6)
    expect(stats.periodReturns.d7).toBeCloseTo(120, 6)
    expect(stats.periodReturns.d30).toBeCloseTo(340, 6)
  })

  it('separates price moves from deposits using cost basis', () => {
    // Value doubled, but every ringgit of it came from new money: cost basis
    // doubled too and unrealized P&L never moved. This is NOT a 100% return.
    const { stats } = computeInvestmentPerformance([
      point({ t: at(1), marketValue: 100, costBasis: 100, unrealizedPl: 0 }),
      point({ t: at(0), marketValue: 200, costBasis: 200, unrealizedPl: 0 }),
    ])
    expect(stats.valueChangePct).toBeCloseTo(100, 6)
    expect(stats.costBasisChangePct).toBeCloseTo(100, 6)
    expect(stats.flowsDetected).toBe(true)
    // The flow-neutral read: margin on cost went nowhere.
    expect(stats.unrealizedPlPctFirst).toBeCloseTo(0, 6)
    expect(stats.unrealizedPlPctLast).toBeCloseTo(0, 6)
  })

  it('reports no flows when cost basis is stable and price moved', () => {
    const { stats } = computeInvestmentPerformance([
      point({ t: at(1), marketValue: 100, costBasis: 100, unrealizedPl: 0 }),
      point({ t: at(0), marketValue: 130, costBasis: 100, unrealizedPl: 30 }),
    ])
    expect(stats.flowsDetected).toBe(false)
    expect(stats.valueChangePct).toBeCloseTo(30, 6)
    expect(stats.costBasisChangePct).toBeCloseTo(0, 6)
    expect(stats.unrealizedPlPctLast).toBeCloseTo(30, 6)
  })

  it('drops non-finite rows rather than corrupting the curve', () => {
    const { series, stats } = computeInvestmentPerformance([
      point({ t: at(2), marketValue: Number.NaN }),
      point({ t: at(1), marketValue: 100 }),
      point({ t: at(0), marketValue: 110 }),
    ])
    expect(series).toHaveLength(2)
    expect(stats.valueChangePct).toBeCloseTo(10, 6)
  })

  it('never divides by a zero starting value', () => {
    const { stats } = computeInvestmentPerformance([
      point({ t: at(1), marketValue: 0, costBasis: 0 }),
      point({ t: at(0), marketValue: 500, costBasis: 500 }),
    ])
    expect(stats.valueChangePct).toBeNull()
    expect(stats.costBasisChangePct).toBeNull()
  })
})
