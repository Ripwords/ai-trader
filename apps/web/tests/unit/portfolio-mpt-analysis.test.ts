import { describe, expect, it } from 'vitest'
import { projectPortfolioMptAnalysis } from '../../server/lib/portfolio-mpt-analysis'
import type { PortfolioCorrelationResult } from '../../server/lib/portfolio-correlation-core'

const base: PortfolioCorrelationResult = {
  analysis_basis: 'modern_portfolio_theory',
  generated_at: '2026-05-24T00:00:00.000Z',
  lookback_days: 252,
  min_returns: 20,
  risk_free_rate: 0.02,
  symbols: ['AAA', 'BBB', 'CCC', 'DDD'],
  assets: [
    { symbol: 'AAA', name: 'Alpha', observations: 120, weight: 0.1, expected_return_annual: 0.11, volatility_annual: 0.22 },
    { symbol: 'BBB', name: 'Bravo', observations: 120, weight: 0.4, expected_return_annual: 0.08, volatility_annual: 0.18 },
    { symbol: 'CCC', name: 'Charlie', observations: 120, weight: 0.3, expected_return_annual: 0.18, volatility_annual: 0.3 },
    { symbol: 'DDD', name: 'Delta', observations: 120, weight: 0.2, expected_return_annual: 0.04, volatility_annual: 0.12 },
  ],
  matrix: [
    [1, 0.7, -0.2, 0.1],
    [0.7, 1, 0.4, -0.5],
    [-0.2, 0.4, 1, 0.05],
    [0.1, -0.5, 0.05, 1],
  ],
  covariance_matrix: [
    [0.04, 0.01, -0.01, 0.002],
    [0.01, 0.03, 0.006, -0.008],
    [-0.01, 0.006, 0.09, 0.001],
    [0.002, -0.008, 0.001, 0.01],
  ],
  current_portfolio: {
    label: 'current',
    expected_return_annual: 0.1,
    volatility_annual: 0.2,
    sharpe_ratio: 0.4,
    weights: { AAA: 0.1, BBB: 0.4, CCC: 0.3, DDD: 0.2 },
  },
  min_variance_portfolio: {
    label: 'sample',
    expected_return_annual: 0.05,
    volatility_annual: 0.11,
    sharpe_ratio: 0.27,
    weights: { AAA: 0.05, BBB: 0.1, CCC: 0.05, DDD: 0.8 },
  },
  max_sharpe_portfolio: {
    label: 'sample',
    expected_return_annual: 0.2,
    volatility_annual: 0.28,
    sharpe_ratio: 0.64,
    weights: { AAA: 0.2, BBB: 0.1, CCC: 0.65, DDD: 0.05 },
  },
  efficient_frontier: [
    { label: 'frontier', expected_return_annual: 0.05, volatility_annual: 0.11, sharpe_ratio: 0.27, weights: { DDD: 0.8 } },
    { label: 'frontier', expected_return_annual: 0.2, volatility_annual: 0.28, sharpe_ratio: 0.64, weights: { CCC: 0.65 } },
  ],
  simulations: [
    { label: 'current', expected_return_annual: 0.1, volatility_annual: 0.2, sharpe_ratio: 0.4, weights: { BBB: 0.4 } },
    { label: 'sample', expected_return_annual: 0.2, volatility_annual: 0.28, sharpe_ratio: 0.64, weights: { CCC: 0.65 } },
    { label: 'sample', expected_return_annual: 0.05, volatility_annual: 0.11, sharpe_ratio: 0.27, weights: { DDD: 0.8 } },
  ],
  excluded: [{ symbol: 'MISSING', reason: 'ticker_not_found' }],
}

describe('portfolio MPT chat analysis projection', () => {
  it('returns a requested ticker subset heatmap without the full matrix', () => {
    const out = projectPortfolioMptAnalysis(base, {
      view: 'heatmap',
      symbols: ['CCC', 'AAA'],
      maxSymbols: 2,
    })

    expect(out.view).toBe('heatmap')
    expect(out.heatmap?.assets.map(asset => asset.symbol)).toEqual(['CCC', 'AAA'])
    expect(out.heatmap?.matrix).toEqual([
      [1, -0.2],
      [-0.2, 1],
    ])
    expect(out.frontier).toBeUndefined()
  })

  it('defaults the heatmap to the highest current weights when no symbols are supplied', () => {
    const out = projectPortfolioMptAnalysis(base, {
      view: 'summary',
      maxSymbols: 3,
    })

    expect(out.heatmap?.subset_reason).toBe('top current weights')
    expect(out.heatmap?.assets.map(asset => asset.symbol)).toEqual(['BBB', 'CCC', 'DDD'])
  })

  it('caps sample points for chat-friendly frontier output', () => {
    const out = projectPortfolioMptAnalysis(base, {
      view: 'frontier',
      sampleLimit: 1,
    })

    expect(out.frontier?.points.length).toBe(2)
    expect(out.frontier?.sample_points.length).toBe(1)
    expect(out.summary.current?.sharpe_ratio).toBe(0.4)
  })
})
