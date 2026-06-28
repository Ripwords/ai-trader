// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ValuationCard from '../../app/components/chat/ValuationCard.vue'

describe('ValuationCard', () => {
  it('shows margin of safety and a veto badge when triggered', () => {
    const wrapper = mount(ValuationCard, {
      props: {
        result: {
          symbol: 'AAPL',
          current_price: '1000',
          fair_value: '150',
          margin_of_safety_pct: '-0.85',
          scenarios: [],
          multiples: null,
          historical_multiples: null,
          reverse_dcf_implied_growth: '0.4',
          data_quality: 'full',
          assumptions_used: null,
          veto: { triggered: true, reason: 'price >= 1.5x DCF fair value (margin of safety -0.85)', rating_cap: 'hold' },
          warnings: [],
        },
      },
    })
    expect(wrapper.text()).toContain('AAPL')
    expect(wrapper.text().toLowerCase()).toContain('veto')
  })

  it('shows an empty state when data_quality is unavailable', () => {
    const wrapper = mount(ValuationCard, {
      props: {
        result: {
          symbol: 'X',
          data_quality: 'unavailable',
          scenarios: [],
          veto: { triggered: false, reason: null, rating_cap: null },
          warnings: ['no financial data available'],
          current_price: '0',
          fair_value: null,
          margin_of_safety_pct: null,
          multiples: null,
          historical_multiples: null,
          reverse_dcf_implied_growth: null,
          assumptions_used: null,
        },
      },
    })
    expect(wrapper.text().toLowerCase()).toContain('unavailable')
  })

  it('does not throw when given an error shape (no veto field)', () => {
    // value_stock returns { error: '...' } on proxy failure; card must not crash
    expect(() => {
      mount(ValuationCard, {
        props: { result: { error: 'valuation failed: 422' } },
      })
    }).not.toThrow()
    const wrapper = mount(ValuationCard, {
      props: { result: { error: 'valuation failed: 422' } },
    })
    // Should render the error message
    expect(wrapper.text()).toContain('valuation failed: 422')
  })
})
