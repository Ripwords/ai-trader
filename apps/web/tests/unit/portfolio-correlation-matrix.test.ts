// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PortfolioCorrelationMatrix from '../../app/components/portfolio/PortfolioCorrelationMatrix.vue'

describe('PortfolioCorrelationMatrix', () => {
  it('renders the matrix and footnotes excluded tickers', () => {
    const wrapper = mount(PortfolioCorrelationMatrix, {
      props: {
        pending: false,
        errorMessage: '',
        correlation: {
          generated_at: '2026-05-24T00:00:00.000Z',
          lookback_days: 252,
          min_returns: 20,
          risk_free_rate: 0.02,
          symbols: ['NVDA', 'TLT'],
          assets: [
            { symbol: 'NVDA', name: 'NVIDIA Corporation', observations: 120 },
            { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', observations: 120 },
          ],
          matrix: [
            [1, -0.42],
            [-0.42, 1],
          ],
          covariance_matrix: [
            [0.09, -0.01],
            [-0.01, 0.04],
          ],
          current_portfolio: {
            label: 'current',
            expected_return_annual: 0.12,
            volatility_annual: 0.22,
            sharpe_ratio: 0.45,
            weights: { NVDA: 0.6, TLT: 0.4 },
          },
          min_variance_portfolio: {
            label: 'sample',
            expected_return_annual: 0.08,
            volatility_annual: 0.14,
            sharpe_ratio: 0.43,
            weights: { NVDA: 0.2, TLT: 0.8 },
          },
          max_sharpe_portfolio: {
            label: 'sample',
            expected_return_annual: 0.16,
            volatility_annual: 0.2,
            sharpe_ratio: 0.7,
            weights: { NVDA: 0.7, TLT: 0.3 },
          },
          efficient_frontier: [
            {
              label: 'frontier',
              expected_return_annual: 0.08,
              volatility_annual: 0.14,
              sharpe_ratio: 0.43,
              weights: { NVDA: 0.2, TLT: 0.8 },
            },
            {
              label: 'frontier',
              expected_return_annual: 0.16,
              volatility_annual: 0.2,
              sharpe_ratio: 0.7,
              weights: { NVDA: 0.7, TLT: 0.3 },
            },
          ],
          simulations: [
            {
              label: 'current',
              expected_return_annual: 0.12,
              volatility_annual: 0.22,
              sharpe_ratio: 0.45,
              weights: { NVDA: 0.6, TLT: 0.4 },
            },
            {
              label: 'sample',
              expected_return_annual: 0.16,
              volatility_annual: 0.2,
              sharpe_ratio: 0.7,
              weights: { NVDA: 0.7, TLT: 0.3 },
            },
          ],
          excluded: [
            { symbol: 'MISSING', reason: 'ticker_not_found' },
          ],
        },
      },
    })

    expect(wrapper.text()).toContain('correlation matrix')
    expect(wrapper.text()).toContain('sharpe check')
    expect(wrapper.text()).toContain('capital allocation line')
    expect(wrapper.text()).toContain('-0.42')
    expect(wrapper.text()).toContain("Footnote: tickers Yahoo can't find or price with enough history are excluded: MISSING.")
  })

  it('keeps matrix tickers visible while scrolling', () => {
    const wrapper = mount(PortfolioCorrelationMatrix, {
      props: {
        pending: false,
        errorMessage: '',
        correlation: {
          generated_at: '2026-05-24T00:00:00.000Z',
          lookback_days: 252,
          min_returns: 20,
          risk_free_rate: 0,
          symbols: ['NVDA', 'TLT'],
          assets: [
            { symbol: 'NVDA', name: 'NVIDIA Corporation', observations: 120 },
            { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', observations: 120 },
          ],
          matrix: [
            [1, -0.42],
            [-0.42, 1],
          ],
          covariance_matrix: [
            [0.09, -0.01],
            [-0.01, 0.04],
          ],
          current_portfolio: null,
          min_variance_portfolio: null,
          max_sharpe_portfolio: null,
          efficient_frontier: [],
          simulations: [],
          excluded: [],
        },
      },
    })

    expect(wrapper.find('.matrix-scroll').exists()).toBe(true)
    expect(wrapper.find('.corner').classes()).toContain('sticky-corner')
    expect(wrapper.find('.column-label').classes()).toContain('sticky-column-label')
    expect(wrapper.find('.row-label').classes()).toContain('sticky-row-label')
  })
})
