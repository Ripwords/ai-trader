import { describe, expect, it } from 'vitest'
import type { FullPortfolio, FullPortfolioPosition } from '../../server/lib/holdings'
import { buildPlanningSummary, normalizePlanningSettings } from '../../server/lib/planning'
import { buildRebalancePlan, planForChat, type Instrument } from '../../server/lib/planning-assistant'
import { HOLDINGS, PLANNING_GET, REBALANCE_PLAN, USD_MYR } from '../eval/support/owner-fixtures'

const round2 = (n: number) => Math.round(n * 100) / 100

function position(symbol: string, name: string, assetClass: string, value: number, price: number, currency: string): FullPortfolioPosition {
  return {
    symbol, name, quantity: 1, market_price: price, market_value: value, investment: value,
    allocation_pct: 0, pnl_pct: 0, asset_class: assetClass, data_source: null, sectors: [], currency,
  }
}

const equity = HOLDINGS.map(h => position(h.symbol, h.name, 'EQUITY', round2(h.qty * h.last * USD_MYR), h.last, 'USD'))
const pension = 32_424
const netWorth = 120_000
const cash = round2(netWorth - pension - equity.reduce((sum, p) => sum + p.market_value, 0))
const portfolio: FullPortfolio = {
  net_worth_total: netWorth, net_worth_currency: 'MYR', cash_total: cash, positions_value: netWorth - cash, total_pnl_pct: 0,
  accounts: [],
  positions: [...equity, position('GF_KWSP', 'KWSP (EPF)', 'FIXED_INCOME', pension, pension, 'MYR'), position('MYR', 'Ringgit', 'LIQUIDITY', cash, 1, 'MYR')],
  moomoo_paper: [], moomoo_live: [], moomoo_live_cash: { USD: 1634.12, MYR: 2000 },
  ghostfolio_status: 'ok', moomoo_status: 'ok', fetched_at: '2026-11-22T01:00:00.000Z',
}
const settings = normalizePlanningSettings({
  target_model: [{ key: 'cash', label: 'Cash', target_pct: 5 }, { key: 'equity', label: 'Equity', target_pct: 95 }, { key: 'bond', label: 'Bonds', target_pct: 0 }],
  locked_symbols: ['GF_KWSP'],
})
const summary = buildPlanningSummary(portfolio, settings)

/** The chat evals stub the plan tools with literals. These keep the literals equal to what the builders return for that book. */
describe('the eval owner\'s plan fixtures', () => {
  it('PLANNING_GET is what planning_get returns for the book', () => {
    expect(planForChat(summary, settings)).toEqual(PLANNING_GET)
  })

  it('REBALANCE_PLAN is what a RM 2,000 contribute-only plan returns for the book', () => {
    const instruments = HOLDINGS.map((h, n): Instrument => ({
      symbol: h.symbol, name: h.name, bucket: 'equity', price: h.last, currency: 'USD', fx_rate: USD_MYR,
      held_shares: h.qty, held_value: equity[n]!.market_value, lot_size: 1, candidate: false,
    }))
    const plan = buildRebalancePlan(summary, {
      instruments, skipped: [], broker_cash: portfolio.moomoo_live_cash, broker_status: 'ok', fetched_at: portfolio.fetched_at,
    }, { mode: 'contribute_only', contribution: 2_000 })
    expect(plan).toEqual(REBALANCE_PLAN)
  })
})
