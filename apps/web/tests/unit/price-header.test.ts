// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PriceHeader from '../../app/components/research/PriceHeader.vue'

const base = {
  symbol: 'MY.1066', name: 'RHB Bank Berhad', last: 7.2, change: 0.12, changePct: 0.0169,
  currency: 'MYR', generatedAt: null, cached: false,
}

describe('PriceHeader', () => {
  it('says the price is delayed from Yahoo when moomoo was refused', () => {
    const w = mount(PriceHeader, { props: { ...base, source: 'yahoo' as const } })
    const ts = w.find('.ts').text()
    expect(ts).toContain('yahoo')
    expect(ts).toContain('delayed')
    expect(ts).not.toContain('moomoo')
    expect(w.find('.ccy').text()).toBe('MYR')
    expect(w.find('.pct').text()).toBe('+1.69%')
  })

  it('credits moomoo by default, including reports cached before the source field', () => {
    const w = mount(PriceHeader, { props: base })
    expect(w.find('.ts').text()).toContain('moomoo')
    expect(w.find('.ts').text()).not.toContain('delayed')
  })
})
