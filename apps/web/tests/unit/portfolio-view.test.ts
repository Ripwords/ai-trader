import { describe, expect, it } from 'vitest'
import type { FullPortfolio, FullPortfolioPosition } from '../../server/lib/holdings'
import type { PortfolioPerformance } from '../../server/lib/portfolio-history'
import type { AllocationRow, PlanningSummary } from '../../server/lib/planning'
import {
  attentionItems,
  fmtCurrency,
  fmtPct,
  holdingRows,
  holdingSources,
  keyFigures,
  parseTab,
  partitionAccounts,
  partitionClosed,
  sortRows,
} from '../../app/utils/portfolio-view'

function position(symbol: string, over: Partial<FullPortfolioPosition> = {}): FullPortfolioPosition {
  return {
    symbol,
    name: `${symbol} Inc.`,
    quantity: 1,
    market_price: 10,
    market_value: 10,
    investment: 8,
    allocation_pct: 1,
    pnl_pct: 25,
    asset_class: 'EQUITY',
    sectors: [],
    currency: 'USD',
    ...over,
  }
}

function portfolio(over: Partial<FullPortfolio> = {}): FullPortfolio {
  return {
    net_worth_total: 152247.53,
    net_worth_currency: 'MYR',
    cash_total: 12666.09,
    positions_value: 137781.73,
    total_pnl_pct: 45.06,
    accounts: [],
    positions: [],
    moomoo_paper: [],
    moomoo_live: [],
    ghostfolio_status: 'ok',
    ...over,
  }
}

function performance(d1: number | null): PortfolioPerformance {
  return {
    series: [],
    stats: {
      count: 2,
      firstAt: '2026-09-26T00:00:00Z',
      lastAt: '2026-10-06T00:00:00Z',
      currency: 'MYR',
      totalReturnPct: 3.45,
      maxDrawdownPct: 0,
      periodReturns: { d1, d7: null, d30: null },
    },
  }
}

describe('parseTab', () => {
  it('accepts the four tabs and falls back to overview', () => {
    expect(parseTab('plan')).toBe('plan')
    expect(parseTab('risk')).toBe('risk')
    expect(parseTab('holdings')).toBe('holdings')
    expect(parseTab(undefined)).toBe('overview')
    expect(parseTab('nope')).toBe('overview')
    expect(parseTab(['plan'])).toBe('overview')
  })
})

describe('holding sources', () => {
  it('offers only sources that have rows', () => {
    expect(holdingSources(portfolio({ positions: [position('A')] }))).toEqual(['all'])
    expect(holdingSources(portfolio({
      positions: [position('A')],
      moomoo_live: [{ symbol: 'US.A', quantity: 1, market_value: 5, pnl_pct: 1, account_id: 'x', currency: 'USD' }],
      moomoo_paper: [{ symbol: 'US.B', quantity: 1, market_value: 5, pnl_pct: 1, account_id: 'y', currency: 'USD' }],
    }))).toEqual(['all', 'live', 'paper'])
  })

  it('maps moomoo rows into the same shape, valued in their own currency', () => {
    const rows = holdingRows(portfolio({
      moomoo_live: [{ symbol: 'US.TSM', quantity: 5, market_value: 2426.7, pnl_pct: 25.81, account_id: 'x', currency: 'USD' }],
    }), 'live')
    expect(rows).toEqual([{ symbol: 'US.TSM', name: null, quantity: 5, value: 2426.7, currency: 'USD', allocationPct: null, pnlPct: 25.81 }])
  })

  it('values the aggregate in the base currency', () => {
    const [row] = holdingRows(portfolio({ positions: [position('NVDA', { market_value: 9765.67, allocation_pct: 6.41 })] }), 'all')
    expect(row).toMatchObject({ symbol: 'NVDA', value: 9765.67, currency: 'MYR', allocationPct: 6.41 })
  })
})

describe('partitionClosed', () => {
  it('moves zero-quantity, zero-value rows out of the open list', () => {
    const rows = holdingRows(portfolio({
      positions: [position('NVDA'), position('ARM', { quantity: 0, market_value: 0, allocation_pct: 0 })],
    }), 'all')
    const { open, closed } = partitionClosed(rows)
    expect(open.map(r => r.symbol)).toEqual(['NVDA'])
    expect(closed.map(r => r.symbol)).toEqual(['ARM'])
  })

  it('keeps a cash-like row that has value but no share count', () => {
    const rows = holdingRows(portfolio({ positions: [position('MYR', { quantity: 0, market_value: 14465.8 })] }), 'all')
    expect(partitionClosed(rows).open).toHaveLength(1)
  })
})

describe('sortRows', () => {
  const rows = holdingRows(portfolio({
    positions: [
      position('B', { allocation_pct: 5, pnl_pct: -3, market_value: 50 }),
      position('A', { allocation_pct: 9, pnl_pct: 12, market_value: 90 }),
      position('C', { allocation_pct: 1, pnl_pct: 40, market_value: 10 }),
    ],
  }), 'all')

  it('sorts by each key in either direction', () => {
    expect(sortRows(rows, 'allocation', 'desc').map(r => r.symbol)).toEqual(['A', 'B', 'C'])
    expect(sortRows(rows, 'pnl', 'desc').map(r => r.symbol)).toEqual(['C', 'A', 'B'])
    expect(sortRows(rows, 'value', 'asc').map(r => r.symbol)).toEqual(['C', 'B', 'A'])
    expect(sortRows(rows, 'symbol', 'asc').map(r => r.symbol)).toEqual(['A', 'B', 'C'])
  })

  it('does not mutate its input', () => {
    const before = rows.map(r => r.symbol)
    sortRows(rows, 'symbol', 'desc')
    expect(rows.map(r => r.symbol)).toEqual(before)
  })
})

describe('partitionAccounts', () => {
  it('separates accounts worth nothing in the base currency', () => {
    const { funded, empty } = partitionAccounts([
      { name: 'KWSP', platform: 'KWSP', currency: 'MYR', balance: 0, value_in_base: 37737.3 },
      { name: 'Wise', platform: 'Wise', currency: 'MYR', balance: 0, value_in_base: 0 },
      { name: 'Boost', platform: 'Boost', currency: 'MYR', balance: 0.16, value_in_base: 0.16 },
    ])
    expect(funded.map(a => a.name)).toEqual(['KWSP', 'Boost'])
    expect(empty.map(a => a.name)).toEqual(['Wise'])
  })
})

describe('keyFigures', () => {
  it('answers net worth, the 1-day move, P&L on cost and cash first', () => {
    const figs = keyFigures(portfolio({ positions: [position('A'), position('B', { quantity: 0, market_value: 0 })] }), performance(1.2))
    expect(figs.map(f => f.label)).toEqual(['net worth', '1-day change', 'p&l on cost', 'cash'])
    expect(figs[0]).toMatchObject({ value: 'MYR 152,247.53', sub: '1 open position' })
    expect(figs[1]).toMatchObject({ value: '+1.20%', tone: 'up' })
    expect(figs[2]).toMatchObject({ value: '+45.06%', tone: 'up', sub: 'unrealised, against what you paid' })
    expect(figs[3]).toMatchObject({ value: 'MYR 12,666.09', sub: '8.3% of net worth' })
  })

  it('says why the 1-day move is missing instead of showing a zero', () => {
    const figs = keyFigures(portfolio(), performance(null))
    expect(figs[1]).toMatchObject({ value: '—', tone: 'neutral', sub: 'needs two daily snapshots' })
  })

  it('shows dashes when Ghostfolio reports no totals', () => {
    const figs = keyFigures(portfolio({ net_worth_total: null, cash_total: null, total_pnl_pct: null }), null)
    expect(figs.map(f => f.value)).toEqual(['—', '—', '—', '—'])
    expect(figs[3]!.sub).toBe('')
  })
})

describe('formatters', () => {
  it('formats money with a currency code and signed percentages', () => {
    expect(fmtCurrency(1234.5, 'MYR')).toBe('MYR 1,234.50')
    expect(fmtCurrency(null, 'MYR')).toBe('—')
    expect(fmtPct(-1.654)).toBe('-1.65%')
    expect(fmtPct(0)).toBe('+0.00%')
    expect(fmtPct(Number.NaN)).toBe('—')
  })
})

describe('attentionItems', () => {
  function plan(over: Partial<PlanningSummary> = {}): PlanningSummary {
    return {
      base_currency: 'MYR',
      net_worth_total: 1000,
      net_worth_adjusted: 1000,
      cash_total: 100,
      positions_value: 900,
      data_quality: 'ok',
      assumptions: { monthly_expenses: 0, emergency_fund_months: 6, monthly_contribution: 0 },
      target_model: [],
      allocation_rows: [],
      rebalance_actions: [],
      goals: [],
      concentration: { top_position: null, positions_over_10_pct: 0, positions_over_20_pct: 0 },
      liabilities: { total_balance: 0, monthly_minimum_payment: 0, weighted_interest_rate_pct: null, rows: [] },
      cashflow: { monthly_income: 0, monthly_expenses: 0, monthly_savings: 0, monthly_surplus: 0, savings_rate_pct: null },
      ...over,
    }
  }
  const row: AllocationRow = {
    key: 'equity', label: 'Equity', target_pct: 60, actual_pct: 80, current_value: 800, target_value: 600,
    drift_pct: 20, action_value: -200, action: 'sell', severity: 'critical',
  }

  it('is empty when the plan is on track', () => {
    expect(attentionItems(plan())).toEqual([])
  })

  it('lists rebalance actions, concentration and goals behind, worst first', () => {
    const items = attentionItems(plan({
      rebalance_actions: [row],
      concentration: { top_position: { symbol: 'NVDA', allocation_pct: 31.4, severity: 'alert' }, positions_over_10_pct: 2, positions_over_20_pct: 1 },
      goals: [
        { key: 'cash', label: 'Cash reserve', current_value: 1, target_value: 2, progress_pct: 50, status: 'behind', note: 'MYR 1 short' },
        { key: 'x', label: 'Done', current_value: 2, target_value: 2, progress_pct: 100, status: 'complete', note: '' },
      ],
    }))
    expect(items.map(i => i.label)).toEqual(['Equity', 'NVDA', 'Cash reserve'])
    expect(items[0]).toMatchObject({ tone: 'down', detail: 'sell MYR 200.00 · 80.0% vs 60.0% target' })
    expect(items[1]).toMatchObject({ tone: 'accent', detail: '31.4% of net worth in one position' })
    expect(items[2]).toMatchObject({ tone: 'accent', detail: 'MYR 1 short' })
  })

  it('ignores a concentration that is ok', () => {
    const items = attentionItems(plan({
      concentration: { top_position: { symbol: 'VT', allocation_pct: 9, severity: 'ok' }, positions_over_10_pct: 0, positions_over_20_pct: 0 },
    }))
    expect(items).toEqual([])
  })
})
