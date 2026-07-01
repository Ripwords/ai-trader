import { describe, it, expect } from 'vitest'
import { computeTechnicals } from '../../server/llm/research/technicals'
import type { DailyBar } from '../../server/lib/yahoo'

// Build a deterministic ascending series: close = 100 + i for i in [0, n).
function ascending(n: number): DailyBar[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + i
    return {
      time: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000 + i,
    }
  })
}

describe('computeTechnicals', () => {
  it('returns an all-null snapshot for empty input (no fabrication)', () => {
    const t = computeTechnicals([])
    expect(t.lastClose).toBeNull()
    expect(t.rsi14).toBeNull()
    expect(t.trend).toBeNull()
  })

  it('computes SMAs, last close, and moving averages from bars', () => {
    const t = computeTechnicals(ascending(260))
    expect(t.lastClose).toBe(359) // 100 + 259
    // last 20 closes are 340..359 -> mean 349.5
    expect(t.sma20).toBeCloseTo(349.5, 5)
    // last 50 closes are 310..359 -> mean 334.5
    expect(t.sma50).toBeCloseTo(334.5, 5)
    expect(t.sma200).not.toBeNull()
  })

  it('reports RSI 100 for a strictly rising series (all gains)', () => {
    const t = computeTechnicals(ascending(60))
    expect(t.rsi14).toBeCloseTo(100, 5)
  })

  it('labels an uptrend when price > sma20 > sma50 > sma200', () => {
    const t = computeTechnicals(ascending(260))
    expect(t.trend).toBe('up')
  })

  it('computes trailing returns as percentages', () => {
    const t = computeTechnicals(ascending(260))
    // 1m ~ 21 trading days back: index 259-21 = 238 -> close 338
    expect(t.return1m).toBeCloseTo(((359 - 338) / 338) * 100, 4)
  })

  it('computes 52-week high/low and distance from them', () => {
    const t = computeTechnicals(ascending(260))
    // over last 252 bars: highest close = 359, lowest = 100 + (259-251) = 108
    expect(t.high52w).toBe(359)
    expect(t.low52w).toBe(108)
    expect(t.pctFrom52wHigh).toBeCloseTo(0, 5) // at the high
    expect(t.pctFrom52wLow).toBeGreaterThan(0)
  })

  it('degrades gracefully when there are fewer bars than a window', () => {
    const t = computeTechnicals(ascending(10))
    expect(t.lastClose).toBe(109)
    expect(t.sma20).toBeNull()
    expect(t.sma200).toBeNull()
    expect(t.return1y).toBeNull()
  })
})
