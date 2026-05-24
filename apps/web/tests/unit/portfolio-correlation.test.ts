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

  it('collects MPT inputs with actual market-value weights when available', () => {
    const portfolio = {
      positions: [
        { symbol: 'NVDA', name: 'NVIDIA Corporation', market_value: 600 },
        { symbol: 'US.NVDA', name: 'NVIDIA duplicate', market_value: 400 },
        { symbol: 'GLD', name: 'SPDR Gold Shares', market_value: 500 },
      ],
      moomoo_live: [{ symbol: 'US.TLT', market_value: 250 }],
      moomoo_paper: [{ symbol: 'US.SPY', market_value: 250 }],
    } as FullPortfolio

    expect(collectPortfolioMptInputs(portfolio)).toEqual([
      { symbol: 'NVDA', name: 'NVIDIA Corporation', market_value: 1000 },
      { symbol: 'GLD', name: 'SPDR Gold Shares', market_value: 500 },
    ])
  })
})
