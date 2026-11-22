import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FullPortfolio, FullPortfolioPosition } from '../../server/lib/holdings'
import { buildPlanningSummary, normalizePlanningSettings } from '../../server/lib/planning'

const yahoo = vi.hoisted(() => ({
  getFxRate: vi.fn(),
  getYahooQuote: vi.fn(),
  resolveSymbol: vi.fn(),
}))

vi.mock('../../server/lib/yahoo', () => ({
  ...yahoo,
  toYahooSymbol: (s: string) => (s.startsWith('US.') ? s.slice(3) : s === 'MY.1066' ? '1066.KL' : s),
}))

function position(symbol: string, assetClass: string, value: number, price: number, currency: string): FullPortfolioPosition {
  return {
    symbol, name: `${symbol} name`, quantity: 10, market_price: price, market_value: value, investment: value,
    allocation_pct: 0, pnl_pct: 0, asset_class: assetClass, data_source: null, sectors: [], currency,
  }
}

const live = (symbol: string, quantity = 10) => ({ symbol, quantity, market_value: 0, pnl_pct: 0, account_id: '1', currency: null })

const portfolio: FullPortfolio = {
  net_worth_total: 150_000, net_worth_currency: 'MYR', cash_total: 0, positions_value: 150_000, total_pnl_pct: 0,
  accounts: [],
  positions: [
    position('MMF', 'LIQUIDITY', 18_000, 1, 'MYR'),
    position('MSFT', 'EQUITY', 45_000, 500, 'USD'),
    position('1066.KL', 'EQUITY', 7_000, 7.2, 'MYR'),
    position('GF_AHAM Select Dividend Fund', 'EQUITY', 20_000, 0.8, 'MYR'),
    position('GF_KWSP', 'FIXED_INCOME', 60_000, 60_000, 'MYR'),
  ],
  moomoo_paper: [live('US.TSLA')],
  moomoo_live: [live('US.MSFT', 4), live('US.MSFT', 5), live('MY.1066')],
  moomoo_live_cash: { MYR: 2_000, USD: 12.5 },
  ghostfolio_status: 'ok',
  moomoo_status: 'ok',
  fetched_at: '2026-11-22T01:00:00.000Z',
}
const summary = buildPlanningSummary(portfolio, normalizePlanningSettings({}))

beforeEach(() => {
  yahoo.getFxRate.mockReset().mockImplementation(async (from: string) => (from === 'USD' ? 4.5 : from === 'MYR' ? 1 : null))
  yahoo.getYahooQuote.mockReset().mockResolvedValue(null)
  yahoo.resolveSymbol.mockReset().mockResolvedValue({ status: 'not_found' })
})

describe('loadRebalanceInputs', () => {
  it('offers only the holdings the live broker accounts hold, with the broker share count, the price in its own currency and the rate to base', async () => {
    const { loadRebalanceInputs } = await import('../../server/lib/rebalance-inputs')
    const out = await loadRebalanceInputs(portfolio, summary, [])
    expect(out.instruments).toEqual([
      { symbol: 'MSFT', name: 'MSFT name', bucket: 'equity', price: 500, currency: 'USD', fx_rate: 4.5, held_shares: 9, held_value: 45_000, candidate: false },
      { symbol: '1066.KL', name: '1066.KL name', bucket: 'equity', price: 7.2, currency: 'MYR', fx_rate: 1, held_shares: 10, held_value: 7_000, candidate: false },
    ])
    expect(out).toMatchObject({ skipped: [], broker_cash: { MYR: 2_000, USD: 12.5 }, broker_status: 'ok', fetched_at: '2026-11-22T01:00:00.000Z' })
  })

  it('leaves out a holding whose currency has no rate and says so', async () => {
    yahoo.getFxRate.mockImplementation(async (from: string) => (from === 'MYR' ? 1 : null))
    const { loadRebalanceInputs } = await import('../../server/lib/rebalance-inputs')
    const out = await loadRebalanceInputs(portfolio, summary, [])
    expect(out.instruments.map(i => i.symbol)).toEqual(['1066.KL'])
    expect(out.skipped).toEqual([{ symbol: 'MSFT', reason: 'no_fx_rate' }])
  })

  it('prices a candidate the broker can trade and marks a held one as a candidate', async () => {
    yahoo.resolveSymbol.mockResolvedValue({ status: 'resolved', symbol: 'US.VOO', moomoo: 'US.VOO', yahoo: 'VOO', name: 'Vanguard S&P 500 ETF', exchange: 'PCX', quoteType: 'ETF' })
    yahoo.getYahooQuote.mockResolvedValue({ name: 'Vanguard S&P 500 ETF', lastPrice: 600, currency: 'USD' })
    const { loadRebalanceInputs } = await import('../../server/lib/rebalance-inputs')
    const out = await loadRebalanceInputs(portfolio, summary, [{ symbol: 'voo', bucket: 'equity' }, { symbol: 'US.MSFT' }])
    expect(out.instruments).toEqual(expect.arrayContaining([
      { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', bucket: 'equity', price: 600, currency: 'USD', fx_rate: 4.5, held_shares: 0, held_value: 0, candidate: true },
      expect.objectContaining({ symbol: 'MSFT', held_shares: 9, candidate: true }),
    ]))
    expect(out.instruments).toHaveLength(3)
    expect(yahoo.resolveSymbol).toHaveBeenCalledTimes(1)
  })

  it('refuses a candidate it cannot place, with the reason', async () => {
    yahoo.resolveSymbol.mockImplementation(async (s: string) => (
      s === 'BTC-USD'
        ? { status: 'resolved', symbol: 'BTC-USD', moomoo: null, yahoo: 'BTC-USD', name: 'Bitcoin', exchange: 'CCC', quoteType: 'CRYPTOCURRENCY' }
        : s === 'QQQ'
          ? { status: 'resolved', symbol: 'US.QQQ', moomoo: 'US.QQQ', yahoo: 'QQQ', name: 'QQQ', exchange: 'NMS', quoteType: 'ETF' }
          : { status: 'not_found' }
    ))
    const { loadRebalanceInputs } = await import('../../server/lib/rebalance-inputs')
    const out = await loadRebalanceInputs(portfolio, summary, [
      { symbol: 'GF_KWSP', bucket: 'bond' },
      { symbol: 'BND' },
      { symbol: 'ZZZZ', bucket: 'bond' },
      { symbol: 'BTC-USD', bucket: 'crypto' },
      { symbol: 'QQQ', bucket: 'equity' },
    ])
    expect(out.skipped).toEqual([
      { symbol: 'GF_KWSP', reason: 'locked' },
      { symbol: 'BND', reason: 'bucket_required' },
      { symbol: 'ZZZZ', reason: 'not_found' },
      { symbol: 'BTC-USD', reason: 'not_tradable' },
      { symbol: 'QQQ', reason: 'no_price' },
    ])
    expect(out.instruments.every(i => !i.candidate)).toBe(true)
  })
})
