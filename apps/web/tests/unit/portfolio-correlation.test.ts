import { describe, expect, it } from 'vitest'
import type { DailyBar } from '../../server/lib/yahoo'
import {
  buildPortfolioCorrelation,
  collectPortfolioCorrelationInputs,
  collectPortfolioMptInputs,
} from '../../server/lib/portfolio-correlation-core'
import type { FullPortfolio } from '../../server/lib/holdings'

function barsFromReturns(symbol: string, returns: number[], start = 100): DailyBar[] {
  let close = start
  const bars: DailyBar[] = [{
    time: '2026-01-01',
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }]

  returns.forEach((r, i) => {
    close = close * (1 + r)
    bars.push({
      time: `2026-01-0${i + 2}`,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
    })
  })

  return bars
}

describe('portfolio correlation', () => {
  it('computes a pairwise correlation matrix from daily returns', () => {
    const result = buildPortfolioCorrelation(
      [
        { symbol: 'AAA', name: 'Alpha' },
        { symbol: 'BBB', name: 'Beta' },
        { symbol: 'CCC', name: 'Contra' },
      ],
      new Map([
        ['AAA', barsFromReturns('AAA', [0.1, 0.2, 0.3, 0.4])],
        ['BBB', barsFromReturns('BBB', [0.2, 0.4, 0.6, 0.8], 50)],
        ['CCC', barsFromReturns('CCC', [-0.1, -0.2, -0.3, -0.4])],
      ]),
      { generatedAt: '2026-05-24T00:00:00.000Z', lookbackDays: 5, minReturns: 3 },
    )

    expect(result.symbols).toEqual(['AAA', 'BBB', 'CCC'])
    expect(result.matrix[0]?.[0]).toBe(1)
    expect(result.matrix[0]?.[1]).toBeCloseTo(1, 6)
    expect(result.matrix[1]?.[0]).toBeCloseTo(1, 6)
    expect(result.matrix[0]?.[2]).toBeCloseTo(-1, 6)
    expect(result.covariance_matrix[0]?.[1]).toBeGreaterThan(0)
    expect(result.analysis_basis).toBe('modern_portfolio_theory')
    expect(result.excluded).toEqual([])
  })

  it('computes current portfolio risk and return from weights, mean returns, and covariance', () => {
    const result = buildPortfolioCorrelation(
      [
        { symbol: 'AAA', name: 'Alpha', market_value: 30 },
        { symbol: 'BBB', name: 'Beta', market_value: 70 },
      ],
      new Map([
        ['AAA', barsFromReturns('AAA', [0.01, 0.02, 0.03, 0.04])],
        ['BBB', barsFromReturns('BBB', [0.04, 0.03, 0.02, 0.01])],
      ]),
      {
        generatedAt: '2026-05-24T00:00:00.000Z',
        lookbackDays: 5,
        minReturns: 3,
        riskFreeRate: 0.02,
        simulations: 0,
      },
    )

    expect(result.assets.map(asset => asset.weight)).toEqual([0.3, 0.7])
    expect(result.current_portfolio?.weights).toEqual({ AAA: 0.3, BBB: 0.7 })
    expect(result.current_portfolio?.expected_return_annual).toBeCloseTo(((0.3 * 0.025) + (0.7 * 0.025)) * 252)
    expect(result.current_portfolio?.volatility_annual).toBeGreaterThan(0)
    expect(result.current_portfolio?.sharpe_ratio).toBeCloseTo(
      ((result.current_portfolio?.expected_return_annual ?? 0) - 0.02) / (result.current_portfolio?.volatility_annual ?? 1),
    )
  })

  it('excludes tickers without enough valid price history', () => {
    const result = buildPortfolioCorrelation(
      [
        { symbol: 'NVDA', name: 'NVIDIA' },
        { symbol: 'MISSING', name: 'Missing' },
        { symbol: 'SHORT', name: 'Short History' },
      ],
      new Map([
        ['NVDA', barsFromReturns('NVDA', [0.03, -0.01, 0.04, 0.02])],
        ['MISSING', []],
        ['SHORT', barsFromReturns('SHORT', [0.01])],
      ]),
      { generatedAt: '2026-05-24T00:00:00.000Z', lookbackDays: 5, minReturns: 3 },
    )

    expect(result.symbols).toEqual(['NVDA'])
    expect(result.excluded).toEqual([
      { symbol: 'MISSING', reason: 'ticker_not_found' },
      { symbol: 'SHORT', reason: 'insufficient_price_history' },
    ])
  })

  it('collects unique symbols across Ghostfolio and Moomoo positions', () => {
    const portfolio = {
      positions: [
        { symbol: 'NVDA', name: 'NVIDIA Corporation' },
        { symbol: 'GLD', name: 'SPDR Gold Shares' },
      ],
      moomoo_live: [{ symbol: 'US.NVDA' }, { symbol: 'US.TLT' }],
      moomoo_paper: [{ symbol: 'US.SPY' }, { symbol: 'US.TLT' }],
    } as FullPortfolio

    expect(collectPortfolioCorrelationInputs(portfolio)).toEqual([
      { symbol: 'NVDA', name: 'NVIDIA Corporation' },
      { symbol: 'GLD', name: 'SPDR Gold Shares' },
      { symbol: 'TLT', name: 'TLT' },
      { symbol: 'SPY', name: 'SPY' },
    ])
  })

  it('collects MPT inputs with actual market-value weights when available', async () => {
    const portfolio = {
      positions: [
        { symbol: 'NVDA', name: 'NVIDIA Corporation', market_value: 600 },
        { symbol: 'US.NVDA', name: 'NVIDIA duplicate', market_value: 400 },
        { symbol: 'GLD', name: 'SPDR Gold Shares', market_value: 500 },
      ],
      moomoo_live: [{ symbol: 'US.TLT', market_value: 250 }],
      moomoo_paper: [{ symbol: 'US.SPY', market_value: 250 }],
    } as FullPortfolio

    expect(await collectPortfolioMptInputs(portfolio)).toEqual([
      { symbol: 'NVDA', name: 'NVIDIA Corporation', market_value: 1000 },
      { symbol: 'GLD', name: 'SPDR Gold Shares', market_value: 500 },
    ])
  })

  it('converts moomoo-only positions to a common currency before weighting', async () => {
    const portfolio = {
      positions: [],
      net_worth_currency: 'USD',
      moomoo_live: [
        { symbol: 'US.NVDA', market_value: 1000, currency: 'USD' },
        { symbol: 'HK.00700', market_value: 800, currency: 'HKD' },
      ],
      moomoo_paper: [],
    } as FullPortfolio

    // Fake FX: 1 HKD = 0.128 USD. USD passes through unchanged.
    const convert = async (amount: number, from: string, to: string) =>
      from === to ? amount : from === 'HKD' && to === 'USD' ? amount * 0.128 : amount

    const inputs = await collectPortfolioMptInputs(portfolio, convert)
    const bySymbol = Object.fromEntries(inputs.map(i => [i.symbol, i.market_value]))
    expect(bySymbol.NVDA).toBe(1000)
    // 800 HKD → 102.4 USD, NOT summed raw as 800.
    expect(bySymbol['0700.HK']).toBeCloseTo(102.4, 5)
  })

  it('weights moomoo-only MPT inputs by the live account, leaving paper positions out', async () => {
    const portfolio = {
      positions: [],
      net_worth_currency: 'USD',
      moomoo_live: [{ symbol: 'US.NVDA', market_value: 1000, currency: 'USD' }],
      moomoo_paper: [{ symbol: 'US.TSLA', market_value: 50_000, currency: 'USD' }, { symbol: 'US.NVDA', market_value: 9000, currency: 'USD' }],
    } as FullPortfolio
    expect(await collectPortfolioMptInputs(portfolio)).toEqual([{ symbol: 'NVDA', name: 'NVDA', market_value: 1000 }])
  })

  it('uses paper positions when there is no live one, rather than showing nothing', async () => {
    const portfolio = {
      positions: [],
      net_worth_currency: 'USD',
      moomoo_live: [],
      moomoo_paper: [{ symbol: 'US.TSLA', market_value: 500, currency: 'USD' }],
    } as FullPortfolio
    expect(await collectPortfolioMptInputs(portfolio)).toEqual([{ symbol: 'TSLA', name: 'TSLA', market_value: 500 }])
  })

  it('marks cash and manual assets instead of treating their symbols as tickers', async () => {
    // Ghostfolio names a cash balance by its currency; on Yahoo "USD" is a
    // leveraged semiconductor ETF.
    const portfolio = {
      positions: [
        { symbol: 'NVDA', name: 'NVIDIA', market_value: 600, asset_class: 'EQUITY', data_source: 'YAHOO' },
        { symbol: 'USD', name: 'USD', market_value: 100, asset_class: 'LIQUIDITY', data_source: 'MANUAL' },
        { symbol: 'GF_KWSP', name: 'KWSP', market_value: 50, asset_class: 'FIXED_INCOME', data_source: 'MANUAL' },
        { symbol: 'VGK', name: 'Vanguard Europe', market_value: 70, asset_class: 'EQUITY', data_source: null },
      ],
    } as unknown as FullPortfolio

    expect(await collectPortfolioMptInputs(portfolio)).toEqual([
      { symbol: 'NVDA', name: 'NVIDIA', market_value: 600 },
      { symbol: 'USD', name: 'USD', market_value: 100, unpriced: 'cash' },
      { symbol: 'GF_KWSP', name: 'KWSP', market_value: 50, unpriced: 'manual_asset' },
      { symbol: 'VGK', name: 'Vanguard Europe', market_value: 70 },
    ])
  })

  it('leaves unpriced holdings out of the model even when a ticker of that name has bars', () => {
    const up = barsFromReturns('A', [0.01, 0.02, -0.01, 0.03])
    const result = buildPortfolioCorrelation(
      [
        { symbol: 'NVDA', name: 'NVIDIA', market_value: 600 },
        { symbol: 'TLT', name: 'TLT', market_value: 300 },
        { symbol: 'USD', name: 'USD', market_value: 100, unpriced: 'cash' },
      ],
      new Map([['NVDA', up], ['TLT', barsFromReturns('B', [-0.01, 0.01, 0.02, -0.02])], ['USD', up]]),
      { lookbackDays: 252, minReturns: 2, simulations: 10 },
    )
    expect(result.symbols).toEqual(['NVDA', 'TLT'])
    expect(result.excluded).toEqual([{ symbol: 'USD', reason: 'cash' }])
  })
})

