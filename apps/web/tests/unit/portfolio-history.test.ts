import { describe, expect, it } from 'vitest'
import type { FullPortfolio } from '../../server/lib/holdings'
import {
  buildSnapshotDetail,
  computePerformance,
  type EquityPoint,
} from '../../server/lib/portfolio-history'

function fullPortfolio(overrides: Partial<FullPortfolio> = {}): FullPortfolio {
  return {
    net_worth_total: 100000,
    net_worth_currency: 'MYR',
    cash_total: 20000,
    positions_value: 80000,
    total_pnl_pct: 12.5,
    accounts: [
      { name: 'moomoo', platform: 'moomoo', currency: 'USD', balance: 1500, value_in_base: 7000 },
    ],
    positions: [
      {
        symbol: 'NVDA', name: 'NVIDIA', quantity: 10, market_price: 180, market_value: 1800,
        investment: 1000, allocation_pct: 1.8, pnl_pct: 80, asset_class: 'EQUITY', sectors: [], currency: 'USD',
      },
    ],
    moomoo_paper: [
      { symbol: 'US.AAPL', quantity: 5, market_value: 1000, pnl_pct: 3, account_id: '1', currency: 'USD' },
    ],
    moomoo_live: [],
    ghostfolio_status: 'ok',
    ...overrides,
  }
}

describe('buildSnapshotDetail', () => {
  it('uses the Ghostfolio aggregate when available', () => {
    const detail = buildSnapshotDetail(fullPortfolio())
    expect(detail.totals).toEqual({
      netWorth: 100000,
      cash: 20000,
      positionsValue: 80000,
      currency: 'MYR',
    })
    expect(detail.perAccount).toHaveLength(1)
    expect(detail.positions).toEqual([
      { symbol: 'NVDA', qty: 10, price: 180, value: 1800, currency: 'USD' },
    ])
  })

  it('refuses to record a broker total as net worth when Ghostfolio is down', () => {
    // moomoo paper + live slices are present, but they are not net worth.
    const full = fullPortfolio({
      ghostfolio_status: 'failing',
      net_worth_total: null,
      cash_total: null,
      positions_value: null,
      accounts: [],
      positions: [],
      moomoo_live: [
        { symbol: 'US.NVDA', quantity: 10, market_value: 4500, pnl_pct: 12, account_id: '2', currency: 'USD' },
      ],
    })
    expect(() => buildSnapshotDetail(full)).toThrow(/ghostfolio is unavailable/i)
  })

  it('throws when the Ghostfolio summary carries no net worth', () => {
    expect(() => buildSnapshotDetail(fullPortfolio({ net_worth_total: null }))).toThrow(/no net-worth data/i)
    expect(() => buildSnapshotDetail(null)).toThrow(/no net-worth data/i)
  })
})

function pt(t: string, netWorth: number): EquityPoint {
  return { t, source: 'auto', netWorth, cash: netWorth * 0.2, positionsValue: netWorth * 0.8, currency: 'MYR' }
}

describe('computePerformance', () => {
  it('drops rows not denominated in the newest snapshot currency', () => {
    // An older capture that fell back to a moomoo paper total (no currency)
    // must not become a fake 98% drawdown against real MYR net worth.
    const perf = computePerformance([
      { ...pt('2026-07-01T08:00:00.000Z', 2000), currency: null },
      { ...pt('2026-07-02T08:00:00.000Z', 1500), currency: 'USD' },
      pt('2026-07-03T08:00:00.000Z', 100000),
      pt('2026-07-10T08:00:00.000Z', 110000),
    ])
    expect(perf.series.map(p => p.netWorth)).toEqual([100000, 110000])
    expect(perf.stats.count).toBe(2)
    expect(perf.stats.currency).toBe('MYR')
    expect(perf.stats.totalReturnPct).toBeCloseTo(10)
    expect(perf.stats.maxDrawdownPct).toBe(0)
  })

  it('returns an empty result when the newest snapshot has no currency', () => {
    const perf = computePerformance([{ ...pt('2026-07-01T08:00:00.000Z', 2000), currency: null }])
    expect(perf.stats.count).toBe(0)
  })

  it('returns an empty result for no snapshots', () => {
    const perf = computePerformance([])
    expect(perf.series).toEqual([])
    expect(perf.stats.count).toBe(0)
    expect(perf.stats.totalReturnPct).toBeNull()
    expect(perf.stats.maxDrawdownPct).toBeNull()
  })

  it('computes total return vs the first snapshot', () => {
    const perf = computePerformance([
      pt('2026-07-01T08:00:00.000Z', 100000),
      pt('2026-07-10T08:00:00.000Z', 110000),
    ])
    expect(perf.stats.count).toBe(2)
    expect(perf.stats.totalReturnPct).toBeCloseTo(10)
    expect(perf.stats.firstAt).toBe('2026-07-01T08:00:00.000Z')
    expect(perf.stats.lastAt).toBe('2026-07-10T08:00:00.000Z')
    expect(perf.stats.currency).toBe('MYR')
  })

  it('computes max drawdown as the worst peak-to-trough decline', () => {
    const perf = computePerformance([
      pt('2026-07-01T08:00:00.000Z', 100),
      pt('2026-07-02T08:00:00.000Z', 120), // peak
      pt('2026-07-03T08:00:00.000Z', 90), // trough: -25% off peak
      pt('2026-07-04T08:00:00.000Z', 130),
    ])
    expect(perf.stats.maxDrawdownPct).toBeCloseTo(-25)
    expect(perf.stats.totalReturnPct).toBeCloseTo(30)
  })

  it('reports period returns against the closest snapshot at least N days old', () => {
    const perf = computePerformance([
      pt('2026-06-01T08:00:00.000Z', 100),
      pt('2026-07-10T08:00:00.000Z', 105),
      pt('2026-07-17T08:00:00.000Z', 110),
      pt('2026-07-18T08:00:00.000Z', 121),
    ])
    // d7: last (121) vs the latest point ≥7 days older than lastAt (105) → +15.24%
    expect(perf.stats.periodReturns.d7).toBeCloseTo((121 / 105 - 1) * 100)
    // d30: last vs 2026-06-01 (100) → +21%
    expect(perf.stats.periodReturns.d30).toBeCloseTo(21)
    // d1: only the 07-17 point is ≥1 day older → vs 110
    expect(perf.stats.periodReturns.d1).toBeCloseTo(10)
  })

  it('leaves a period return null when no snapshot is old enough', () => {
    const perf = computePerformance([
      pt('2026-07-18T08:00:00.000Z', 100),
      pt('2026-07-18T09:00:00.000Z', 101),
    ])
    expect(perf.stats.periodReturns.d1).toBeNull()
    expect(perf.stats.periodReturns.d30).toBeNull()
  })

  it('skips non-finite net worth rows', () => {
    const perf = computePerformance([
      pt('2026-07-01T08:00:00.000Z', 100),
      { ...pt('2026-07-02T08:00:00.000Z', 0), netWorth: Number.NaN },
      pt('2026-07-03T08:00:00.000Z', 120),
    ])
    expect(perf.series).toHaveLength(2)
    expect(perf.stats.totalReturnPct).toBeCloseTo(20)
  })
})
