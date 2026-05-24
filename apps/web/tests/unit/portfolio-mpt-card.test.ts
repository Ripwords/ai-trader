// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PortfolioMptCard from '../../app/components/chat/PortfolioMptCard.vue'

describe('PortfolioMptCard', () => {
  it('renders summary, frontier, and subset heatmap output from the chat tool', () => {
    const wrapper = mount(PortfolioMptCard, {
      props: {
        analysis: {
          view: 'frontier',
          generated_at: '2026-05-24T00:00:00.000Z',
          lookback_days: 252,
          risk_free_rate: 0.02,
          valid_tickers: 3,
          summary: {
            current: { label: 'current', expected_return_annual: 0.1, volatility_annual: 0.2, sharpe_ratio: 0.4, weights: { AAA: 0.5, BBB: 0.5 } },
            min_variance: { label: 'sample', expected_return_annual: 0.04, volatility_annual: 0.1, sharpe_ratio: 0.2, weights: { BBB: 1 } },
            max_sharpe: { label: 'sample', expected_return_annual: 0.2, volatility_annual: 0.25, sharpe_ratio: 0.72, weights: { CCC: 0.7, AAA: 0.3 } },
            sharpe_gap: 0.32,
            sharpe_status: 'large gap',
          },
          frontier: {
            points: [
              { label: 'frontier', expected_return_annual: 0.04, volatility_annual: 0.1, sharpe_ratio: 0.2, weights: { BBB: 1 } },
              { label: 'frontier', expected_return_annual: 0.2, volatility_annual: 0.25, sharpe_ratio: 0.72, weights: { CCC: 0.7, AAA: 0.3 } },
            ],
            sample_points: [
              { label: 'sample', expected_return_annual: 0.1, volatility_annual: 0.2, sharpe_ratio: 0.4, weights: { AAA: 0.5, BBB: 0.5 } },
            ],
          },
          heatmap: {
            subset_reason: 'requested symbols',
            assets: [
              { symbol: 'AAA', name: 'Alpha', weight: 0.5 },
              { symbol: 'BBB', name: 'Bravo', weight: 0.5 },
            ],
            matrix: [
              [1, -0.4],
              [-0.4, 1],
            ],
          },
          excluded: [{ symbol: 'MISSING', reason: 'ticker_not_found' }],
        },
      },
    })

    expect(wrapper.text()).toContain('portfolio mpt analysis')
    expect(wrapper.text()).toContain('large gap')
    expect(wrapper.text()).toContain('requested symbols')
    expect(wrapper.text()).toContain('-0.40')
    expect(wrapper.text()).toContain('MISSING')
    expect(wrapper.find('svg[aria-label="Portfolio efficient frontier"]').exists()).toBe(true)
  })
})
