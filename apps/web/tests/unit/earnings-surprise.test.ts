import { describe, expect, it, vi } from 'vitest'
import { shapeEarningsSurprise } from '../../server/lib/earnings-surprise'

vi.mock('../../server/lib/yahoo', () => ({ yahooClient: {}, toYahooSymbol: (s: string) => s }))

// Captured from yahoo-finance2 quoteSummary for AMZN after the Q3 2026 print.
const epoch = (iso: string) => Date.parse(iso) / 1000
const RAW = {
  earningsHistory: {
    history: [
      { epsActual: 1.95, epsEstimate: 1.9596, surprisePercent: -0.0049, quarter: '2025-12-31T00:00:00.000Z', period: '-4q' },
      { epsActual: 2.78, epsEstimate: 1.653, surprisePercent: 0.6818, quarter: '2026-03-31T00:00:00.000Z', period: '-3q' },
      { epsActual: 5.75, epsEstimate: 1.8246, surprisePercent: 2.1514, quarter: '2026-06-30T00:00:00.000Z', period: '-2q' },
      { epsActual: 1.89, epsEstimate: 1.95787, surprisePercent: -0.0347, quarter: '2026-09-30T00:00:00.000Z', period: '-1q' },
    ],
  },
  earnings: {
    earningsChart: {
      quarterly: [
        { date: '4Q2025', actual: 1.95, estimate: 1.9596, periodEndDate: epoch('2025-12-31'), reportedDate: epoch('2026-02-05T21:01:00Z') },
        { date: '1Q2026', actual: 2.78, estimate: 1.653, periodEndDate: epoch('2026-03-31'), reportedDate: epoch('2026-04-30T20:01:00Z') },
        { date: '2Q2026', actual: 5.75, estimate: 1.8246, periodEndDate: epoch('2026-06-30'), reportedDate: epoch('2026-07-30T20:01:00Z') },
        { date: '3Q2026', actual: 1.89, estimate: 1.95787, periodEndDate: epoch('2026-09-30'), reportedDate: epoch('2026-10-29T20:01:00Z') },
      ],
    },
    financialsChart: {
      quarterly: [
        { date: '2Q2026', revenue: 167_700_000_000, earnings: 60_000_000_000 },
        { date: '3Q2026', revenue: 201_944_000_000, earnings: 20_685_000_000 },
      ],
    },
  },
  earningsTrend: {
    trend: [
      {
        period: '0q', endDate: '2026-12-31T00:00:00.000Z',
        earningsEstimate: { avg: 2.44273, low: 2.18, high: 2.67, yearAgoEps: 1.95, numberOfAnalysts: 39, growth: 0.2527 },
        revenueEstimate: { avg: 244313309730, low: 240000000000, high: 247611000000, numberOfAnalysts: 39, yearAgoRevenue: 213386000000, growth: 0.1449 },
        epsTrend: { 'current': 2.44273, '7daysAgo': 2.44778, '30daysAgo': 2.43431, '60daysAgo': 2.44025, '90daysAgo': 2.43411 },
        epsRevisions: { upLast7days: 1, upLast30days: 2, downLast30days: 1, downLast7Days: 0 },
      },
      { period: '0y', endDate: '2026-12-31T00:00:00.000Z', earningsEstimate: { avg: 12.9, numberOfAnalysts: 50 }, revenueEstimate: { avg: 790e9 } },
    ],
  },
  calendarEvents: { earnings: { earningsDate: ['2026-10-29T20:00:00.000Z'], isEarningsDateEstimate: false } },
}

const NOW = Date.parse('2026-10-31T12:00:00Z')

describe('shapeEarningsSurprise', () => {
  it('lists quarters oldest to newest with EPS estimate, actual and surprise %', () => {
    const s = shapeEarningsSurprise('AMZN', RAW, NOW)
    expect(s.quarters.map(q => q.fiscal_quarter)).toEqual(['4Q2025', '1Q2026', '2Q2026', '3Q2026'])
    const q3 = s.quarters.at(-1)!
    expect(q3).toMatchObject({
      period_end: '2026-09-30', reported_date: '2026-10-29',
      eps_estimate: 1.95787, eps_actual: 1.89, eps_surprise_pct: -3.47,
      revenue_actual: 201_944_000_000, revenue_estimate: null,
    })
    expect(q3.days_since_report).toBe(2)
    expect(s.latest?.fiscal_quarter).toBe('3Q2026')
    expect(s.quarters[2]?.eps_surprise_pct).toBe(215.14)
  })

  it('carries next-quarter and full-year consensus with revisions', () => {
    const s = shapeEarningsSurprise('AMZN', RAW, NOW)
    expect(s.next_quarter).toMatchObject({
      period_end: '2026-12-31', eps_avg: 2.44273, eps_low: 2.18, eps_high: 2.67, analysts: 39,
      revenue_avg: 244313309730, revenue_low: 240000000000, revenue_high: 247611000000,
      year_ago_eps: 1.95, year_ago_revenue: 213386000000,
    })
    expect(s.next_quarter?.eps_trend).toEqual({ current: 2.44273, d7: 2.44778, d30: 2.43431, d60: 2.44025, d90: 2.43411 })
    expect(s.next_quarter?.revisions).toEqual({ up_7d: 1, up_30d: 2, down_7d: 0, down_30d: 1 })
    expect(s.current_year?.eps_avg).toBe(12.9)
  })

  it('names its source and says past revenue consensus is not available', () => {
    const s = shapeEarningsSurprise('AMZN', RAW, NOW)
    expect(s.source).toContain('Yahoo Finance consensus')
    expect(s.notes.join(' ')).toMatch(/revenue consensus/i)
  })

  it('computes the surprise when Yahoo omits surprisePercent, and survives empty modules', () => {
    const raw = { earningsHistory: { history: [{ epsActual: 1.1, epsEstimate: 1.0, quarter: '2026-09-30T00:00:00.000Z' }] } }
    const s = shapeEarningsSurprise('X', raw, NOW)
    expect(s.quarters[0]?.eps_surprise_pct).toBe(10)
    expect(s.next_quarter).toBeNull()
    expect(shapeEarningsSurprise('X', {}, NOW).quarters).toEqual([])
  })
})
