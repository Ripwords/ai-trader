import { describe, expect, it } from 'vitest'
import type { FullPortfolio } from '../../server/lib/holdings'
import { buildPlanningSnapshot, buildPlanningSummary, mergePlanningSnapshotHistory, normalizePlanningSettings } from '../../server/lib/planning'

function portfolio(overrides: Partial<FullPortfolio> = {}): FullPortfolio {
  return {
    net_worth_total: 100_000,
    net_worth_currency: 'MYR',
    cash_total: 5_000,
    positions_value: 95_000,
    total_pnl_pct: 12,
    accounts: [],
    positions: [
      {
        symbol: 'NVDA',
        name: 'NVIDIA',
        quantity: 10,
        market_price: 2_500,
        market_value: 25_000,
        investment: 10_000,
        allocation_pct: 25,
        pnl_pct: 150,
        asset_class: 'EQUITY',
        sectors: ['Technology'],
        currency: 'USD',
      },
      {
        symbol: 'VOO',
        name: 'Vanguard S&P 500 ETF',
        quantity: 100,
        market_price: 700,
        market_value: 70_000,
        investment: 65_000,
        allocation_pct: 70,
        pnl_pct: 7.7,
        asset_class: 'EQUITY',
        sectors: ['ETF'],
        currency: 'USD',
      },
    ],
    moomoo_paper: [],
    moomoo_live: [],
    ghostfolio_status: 'ok',
    ...overrides,
  }
}

describe('planning summary', () => {
  it('computes allocation drift and rebalance values from the full portfolio', () => {
    const out = buildPlanningSummary(portfolio())

    expect(out.base_currency).toBe('MYR')
    expect(out.net_worth_total).toBe(100_000)
    expect(out.allocation_rows).toContainEqual({
      key: 'cash',
      label: 'Cash',
      target_pct: 10,
      actual_pct: 5,
      current_value: 5_000,
      target_value: 10_000,
      drift_pct: -5,
      action_value: 5_000,
      action: 'buy',
      severity: 'watch',
    })
    expect(out.allocation_rows).toContainEqual({
      key: 'equity',
      label: 'Equity',
      target_pct: 85,
      actual_pct: 95,
      current_value: 95_000,
      target_value: 85_000,
      drift_pct: 10,
      action_value: -10_000,
      action: 'sell',
      severity: 'alert',
    })
    expect(out.rebalance_actions.map(a => a.key)).toEqual(['equity', 'cash', 'bond'])
  })

  it('surfaces cash reserve and concentration goals', () => {
    const out = buildPlanningSummary(portfolio())

    expect(out.goals).toContainEqual({
      key: 'cash_reserve',
      label: 'Cash Reserve',
      current_value: 5_000,
      target_value: 10_000,
      progress_pct: 50,
      status: 'behind',
      note: 'Cash is below the 10% reserve target.',
    })
    expect(out.concentration.top_position).toMatchObject({
      symbol: 'VOO',
      allocation_pct: 70,
      severity: 'critical',
    })
    expect(out.concentration.positions_over_10_pct).toBe(2)
    expect(out.concentration.positions_over_20_pct).toBe(2)
  })

  it('adds a 0% row for a held bucket the target model does not mention', () => {
    // 5k cash + 65k equity + 30k crypto against the default cash/equity/bond
    // model. Without the crypto row, equity read 65% vs 85% target ("buy
    // 20k") on a fully invested portfolio and the rows summed to 70%.
    const out = buildPlanningSummary(portfolio({
      positions: [
        {
          symbol: 'NVDA', name: 'NVIDIA', quantity: 10, market_price: 6_500, market_value: 65_000,
          investment: 50_000, allocation_pct: 65, pnl_pct: 30, asset_class: 'EQUITY', sectors: [], currency: 'USD',
        },
        {
          symbol: 'BTC-USD', name: 'Bitcoin', quantity: 1, market_price: 30_000, market_value: 30_000,
          investment: 20_000, allocation_pct: 30, pnl_pct: 50, asset_class: 'CRYPTOCURRENCY', sectors: [], currency: 'USD',
        },
      ],
    }))
    const crypto = out.allocation_rows.find(row => row.key === 'crypto')
    expect(crypto).toMatchObject({ label: 'Crypto', target_pct: 0, actual_pct: 30, current_value: 30_000, action: 'sell' })
    expect(out.allocation_rows.reduce((sum, row) => sum + row.actual_pct, 0)).toBe(100)
    // A submitted crypto target survives normalisation instead of being dropped.
    const kept = buildPlanningSummary(portfolio(), {
      target_model: [
        { key: 'cash', label: 'Cash', target_pct: 10 },
        { key: 'equity', label: 'Equity', target_pct: 60 },
        { key: 'bond', label: 'Bonds', target_pct: 5 },
        { key: 'crypto', label: 'Crypto', target_pct: 25 },
      ],
      monthly_expenses: 0,
      emergency_fund_months: 6,
      monthly_contribution: 0,
    })
    expect(kept.target_model.map(t => [t.key, t.target_pct])).toEqual([
      ['cash', 10], ['equity', 60], ['bond', 5], ['crypto', 25],
    ])
  })

  it('uses custom target allocations when settings are provided', () => {
    const out = buildPlanningSummary(portfolio(), {
      target_model: [
        { key: 'cash', label: 'Cash', target_pct: 20 },
        { key: 'equity', label: 'Equity', target_pct: 70 },
        { key: 'bond', label: 'Bonds', target_pct: 10 },
      ],
      monthly_expenses: 0,
      emergency_fund_months: 6,
      monthly_contribution: 0,
    })

    expect(out.target_model.map(t => [t.key, t.target_pct])).toEqual([
      ['cash', 20],
      ['equity', 70],
      ['bond', 10],
    ])
    expect(out.allocation_rows.find(row => row.key === 'cash')).toMatchObject({
      target_pct: 20,
      target_value: 20_000,
      drift_pct: -15,
      action_value: 15_000,
      severity: 'alert',
    })
    expect(out.allocation_rows.find(row => row.key === 'equity')).toMatchObject({
      target_pct: 70,
      target_value: 70_000,
      drift_pct: 25,
      action_value: -25_000,
      severity: 'alert',
    })
  })

  it('uses emergency fund assumptions for cash reserve goal', () => {
    const out = buildPlanningSummary(portfolio(), {
      target_model: [
        { key: 'cash', label: 'Cash', target_pct: 10 },
        { key: 'equity', label: 'Equity', target_pct: 85 },
        { key: 'bond', label: 'Bonds', target_pct: 5 },
      ],
      monthly_expenses: 6_000,
      emergency_fund_months: 6,
      monthly_contribution: 4_000,
    })

    expect(out.assumptions).toEqual({
      monthly_expenses: 6_000,
      emergency_fund_months: 6,
      monthly_contribution: 4_000,
    })
    expect(out.goals.find(goal => goal.key === 'cash_reserve')).toMatchObject({
      target_value: 36_000,
      progress_pct: 13.89,
      status: 'behind',
      note: 'Cash is below the 6-month reserve target.',
    })
    expect(out.goals.find(goal => goal.key === 'monthly_contribution')).toMatchObject({
      current_value: 4_000,
      target_value: 36_000,
      progress_pct: 11.11,
      status: 'on_track',
    })
  })

  it('normalizes incomplete settings without losing valid custom values', () => {
    const out = normalizePlanningSettings({
      target_model: [
        { key: 'cash', label: 'Cash Buffer', target_pct: 15 },
        { key: 'equity', label: 'Growth', target_pct: 80 },
      ],
      monthly_expenses: -10,
      emergency_fund_months: 18,
      monthly_contribution: 2500,
      liabilities: [
        { id: 'mortgage', name: 'Mortgage', balance: 250000.123, interest_rate_pct: 4.219, minimum_payment: 1800.123 },
        { id: '', name: '', balance: -1, interest_rate_pct: -2, minimum_payment: -3 },
      ],
      cashflow_items: [
        { id: 'salary', name: 'Salary', kind: 'income', amount: 12000.129 },
        { id: 'bad', name: 'Bad', kind: 'unknown', amount: 99 },
        { id: '', name: '', kind: 'expense', amount: -1 },
      ],
    })

    expect(out.target_model.map(t => [t.key, t.label, t.target_pct])).toEqual([
      ['cash', 'Cash Buffer', 15],
      ['equity', 'Growth', 80],
      ['bond', 'Bonds', 5],
    ])
    expect(out.monthly_expenses).toBe(0)
    expect(out.emergency_fund_months).toBe(18)
    expect(out.monthly_contribution).toBe(2500)
    expect(out.liabilities).toEqual([
      {
        id: 'mortgage',
        name: 'Mortgage',
        balance: 250000.12,
        interest_rate_pct: 4.22,
        minimum_payment: 1800.12,
      },
    ])
    expect(out.cashflow_items).toEqual([
      {
        id: 'salary',
        name: 'Salary',
        kind: 'income',
        amount: 12000.13,
      },
    ])
  })

  it('preserves an explicitly zeroed target bucket without inflating the total', () => {
    // Repro of the /portfolio save-wedge bug: the UI submits all three
    // buckets with one set to 0 and the rest balanced to 100. normalize must
    // not silently re-inflate the zeroed bucket to its default %, otherwise
    // the returned model no longer sums to 100, targetTotalOk turns false,
    // and the save button locks out.
    const out = normalizePlanningSettings({
      target_model: [
        { key: 'cash', label: 'Cash', target_pct: 10 },
        { key: 'equity', label: 'Equity', target_pct: 90 },
        { key: 'bond', label: 'Bonds', target_pct: 0 },
      ],
      monthly_expenses: 0,
      emergency_fund_months: 6,
      monthly_contribution: 0,
    })

    expect(out.target_model.reduce((sum, t) => sum + t.target_pct, 0)).toBe(100)
    // Idempotent: re-normalizing the saved model keeps the 100 total, so the
    // page can round-trip settings without wedging the save button.
    const again = normalizePlanningSettings(out)
    expect(again.target_model.reduce((sum, t) => sum + t.target_pct, 0)).toBe(100)
  })

  it('subtracts liabilities from net worth and summarizes monthly cashflow', () => {
    const out = buildPlanningSummary(portfolio(), {
      target_model: [
        { key: 'cash', label: 'Cash', target_pct: 10 },
        { key: 'equity', label: 'Equity', target_pct: 85 },
        { key: 'bond', label: 'Bonds', target_pct: 5 },
      ],
      monthly_expenses: 6_000,
      emergency_fund_months: 6,
      monthly_contribution: 4_000,
      liabilities: [
        { id: 'mortgage', name: 'Mortgage', balance: 250_000, interest_rate_pct: 4.2, minimum_payment: 1800 },
        { id: 'card', name: 'Credit Card', balance: 5_000, interest_rate_pct: 18, minimum_payment: 300 },
      ],
      cashflow_items: [
        { id: 'salary', name: 'Salary', kind: 'income', amount: 12_000 },
        { id: 'rent', name: 'Rent', kind: 'expense', amount: 3_000 },
        { id: 'dca', name: 'DCA', kind: 'saving', amount: 4_000 },
      ],
    })

    expect(out.net_worth_adjusted).toBe(-155_000)
    expect(out.liabilities).toMatchObject({
      total_balance: 255_000,
      monthly_minimum_payment: 2_100,
      weighted_interest_rate_pct: 4.47,
    })
    expect(out.liabilities.rows.map(row => row.id)).toEqual(['card', 'mortgage'])
    expect(out.cashflow).toEqual({
      monthly_income: 12_000,
      monthly_expenses: 3_000,
      monthly_savings: 4_000,
      monthly_surplus: 5_000,
      savings_rate_pct: 33.33,
    })
    expect(out.goals.find(goal => goal.key === 'debt_load')).toMatchObject({
      current_value: 255_000,
      target_value: 0,
      progress_pct: 0,
      status: 'behind',
    })
  })

  it('builds a compact net-worth snapshot for history capture', () => {
    const summary = buildPlanningSummary(portfolio(), {
      liabilities: [
        { id: 'card', name: 'Credit Card', balance: 5_000, interest_rate_pct: 18, minimum_payment: 300 },
      ],
      cashflow_items: [
        { id: 'salary', name: 'Salary', kind: 'income', amount: 12_000 },
        { id: 'dca', name: 'DCA', kind: 'saving', amount: 4_000 },
      ],
    })

    expect(buildPlanningSnapshot(summary, new Date('2026-05-16T09:30:00.000Z'))).toEqual({
      captured_at: '2026-05-16T09:30:00.000Z',
      date: '2026-05-16',
      base_currency: 'MYR',
      net_worth_total: 100_000,
      net_worth_adjusted: 95_000,
      liabilities_total: 5_000,
      cash_total: 5_000,
      positions_value: 95_000,
      monthly_surplus: 8_000,
      savings_rate_pct: 33.33,
    })
  })

  it('keeps one snapshot per day and caps history length', () => {
    const existing = Array.from({ length: 3 }, (_, index) => ({
      captured_at: `2026-05-${String(index + 10).padStart(2, '0')}T00:00:00.000Z`,
      date: `2026-05-${String(index + 10).padStart(2, '0')}`,
      base_currency: 'MYR',
      net_worth_total: 100_000 + index,
      net_worth_adjusted: 99_000 + index,
      liabilities_total: 1_000,
      cash_total: 5_000,
      positions_value: 95_000,
      monthly_surplus: 1_000,
      savings_rate_pct: null,
    }))
    const replacement = {
      ...existing[1],
      captured_at: '2026-05-11T12:00:00.000Z',
      net_worth_total: 123_456,
      net_worth_adjusted: 122_456,
    }

    expect(mergePlanningSnapshotHistory(existing, replacement, 2)).toEqual([
      replacement,
      existing[2],
    ])
  })
})
