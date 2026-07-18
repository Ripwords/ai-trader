// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TechnicalsCard from '../../app/components/chat/TechnicalsCard.vue'

const snapshot = {
  asOf: '2026-07-17',
  lastClose: 359,
  sma20: 349.5,
  sma50: 334.5,
  sma200: 259.5,
  high52w: 359,
  low52w: 108,
  pctFrom52wHigh: 0,
  pctFrom52wLow: 232.4,
  rsi14: 71.2,
  return1m: 6.2,
  return3m: 18.7,
  return6m: 43.1,
  return1y: 120.4,
  avgVolume20: 1249.5,
  trend: 'up' as const,
  ema12: 353.5,
  ema26: 346.5,
  macd: { line: 7.0, signal: 6.9, histogram: 0.1, cross: null },
  bollinger: { upper: 361.03, mid: 349.5, lower: 337.97, percentB: 0.91, bandwidth: 0.066 },
  atr14: 1,
  atrPct: 0.28,
  stochastic: { k: 100, d: 98.5, reading: 'overbought' as const },
  obv: { value: 240000, trend20: 'up' as const },
  volumeVsAvg20: 1.01,
  smaCross: { golden: false, death: false, withinBars: 10 },
  support: [{ price: 320, time: '2026-06-20', distancePct: -10.86 }],
  resistance: [{ price: 365, time: '2026-07-01', distancePct: 1.67 }],
  signals: [
    { indicator: 'trend', reading: 'uptrend (SMA ladder aligned)', signal: 'bullish' as const, detail: 'close 359.00 vs SMA20 349.50 / SMA50 334.50 / SMA200 259.50' },
    { indicator: 'rsi14', reading: 'overbought (71.2)', signal: 'bearish' as const, detail: 'Wilder RSI(14); >=70 overbought, <=30 oversold' },
    { indicator: 'volume', reading: '1.01x 20-day average', signal: 'neutral' as const, detail: 'normal volume' },
  ],
  note: null,
}

describe('TechnicalsCard', () => {
  it('renders the header, signals with badges, key readouts, SMA ladder, and levels', () => {
    const wrapper = mount(TechnicalsCard, {
      props: { result: { symbol: 'US.NVDA', name: 'NVIDIA Corporation', bar_count: 260, snapshot } },
    })
    const text = wrapper.text()
    expect(text).toContain('US.NVDA')
    expect(text.toLowerCase()).toContain('up') // trend badge
    // signals with their readings
    expect(text).toContain('overbought (71.2)')
    expect(text).toContain('uptrend (SMA ladder aligned)')
    expect(wrapper.findAll('.sig-bullish').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.sig-bearish').length).toBeGreaterThan(0)
    // key readouts
    expect(text).toContain('rsi')
    expect(text).toContain('71.2')
    expect(text).toContain('macd')
    // SMA ladder
    expect(text).toContain('349.50')
    expect(text).toContain('259.50')
    // support / resistance
    expect(text).toContain('365.00')
    expect(text).toContain('320.00')
  })

  it('shows the short-history note when present', () => {
    const wrapper = mount(TechnicalsCard, {
      props: {
        result: {
          symbol: 'US.NEW',
          name: 'New Listing',
          bar_count: 10,
          snapshot: { ...snapshot, note: 'short history (10 bars) — long-window indicators (SMA200/MACD/ATR) may be null' },
        },
      },
    })
    expect(wrapper.text()).toContain('short history (10 bars)')
  })

  it('does not throw when given an error shape (no snapshot field)', () => {
    expect(() => {
      mount(TechnicalsCard, { props: { result: { error: 'no daily bars available for US.ZZZZ' } } })
    }).not.toThrow()
    const wrapper = mount(TechnicalsCard, { props: { result: { error: 'no daily bars available for US.ZZZZ' } } })
    expect(wrapper.text()).toContain('no daily bars available for US.ZZZZ')
  })
})
