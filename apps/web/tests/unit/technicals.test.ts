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

// 250 flat bars at 100, then `drops` bars falling 2 per bar. Volume constant.
function flatThenDrop(flat = 250, drops = 10): DailyBar[] {
  return Array.from({ length: flat + drops }, (_, i) => {
    const close = i < flat ? 100 : 100 - 2 * (i - flat + 1)
    return { time: `2025-02-${String((i % 28) + 1).padStart(2, '0')}`, open: close, high: close, low: close, close, volume: 1000 }
  })
}

describe('computeTechnicals — extended indicators', () => {
  it('computes EMA/MACD/Bollinger/ATR/stochastic/OBV for a rising series', () => {
    const t = computeTechnicals(ascending(260))
    expect(t.ema12).not.toBeNull()
    expect(t.ema26).not.toBeNull()
    expect(t.ema12!).toBeGreaterThan(t.ema26!)
    expect(t.macd.line).not.toBeNull()
    expect(t.macd.line!).toBeGreaterThan(0)
    expect(t.macd.signal).not.toBeNull()
    // strictly rising bars with high=low=close: TR is always 1 -> ATR 1
    expect(t.atr14).toBe(1)
    expect(t.atrPct).toBeCloseTo((1 / 359) * 100, 2)
    // close is pinned to the top of every 14-bar range
    expect(t.stochastic.k).toBe(100)
    expect(t.stochastic.reading).toBe('overbought')
    expect(t.bollinger.percentB).not.toBeNull()
    expect(t.bollinger.percentB!).toBeGreaterThan(0.5)
    expect(t.obv.trend20).toBe('up')
    // volume 1240..1259 avg 1249.5, last 1259
    expect(t.volumeVsAvg20).toBeCloseTo(1259 / 1249.5, 2)
    expect(t.smaCross.golden).toBe(false)
    expect(t.smaCross.death).toBe(false)
    expect(t.note).toBeNull()
  })

  it('emits an honest signals array with deterministic readings', () => {
    const t = computeTechnicals(ascending(260))
    expect(Array.isArray(t.signals)).toBe(true)
    const byIndicator = new Map(t.signals.map(s => [s.indicator, s]))
    expect(byIndicator.get('trend')?.signal).toBe('bullish')
    // RSI 100 = overbought -> bearish reading, honestly reported
    expect(byIndicator.get('rsi14')?.signal).toBe('bearish')
    expect(byIndicator.get('stochastic')?.signal).toBe('bearish')
    expect(byIndicator.get('obv')?.signal).toBe('bullish')
    for (const s of t.signals) {
      expect(['bullish', 'bearish', 'neutral']).toContain(s.signal)
      expect(s.reading.length).toBeGreaterThan(0)
      expect(s.detail.length).toBeGreaterThan(0)
    }
  })

  it('detects a recent MACD bearish cross and a death cross after a breakdown', () => {
    const t = computeTechnicals(flatThenDrop(250, 10))
    expect(t.macd.cross).toBe('bearish')
    expect(t.smaCross.death).toBe(true)
    expect(t.smaCross.golden).toBe(false)
    // all-loss tail: RSI 0 -> oversold reads bullish; stochastic pinned low
    expect(t.rsi14).toBe(0)
    expect(t.stochastic.reading).toBe('oversold')
    const macdSignal = t.signals.find(s => s.indicator === 'macd')
    expect(macdSignal?.signal).toBe('bearish')
    expect(macdSignal?.reading).toContain('cross')
    const crossSignal = t.signals.find(s => s.indicator === 'sma_cross')
    expect(crossSignal?.signal).toBe('bearish')
  })

  it('finds recent swing support/resistance pivots with distances', () => {
    // flat, spike up, flat, dip down, flat -> one resistance + one support
    const bars: DailyBar[] = Array.from({ length: 60 }, (_, i) => {
      let close = 100
      if (i === 40) close = 120
      if (i === 50) close = 80
      return { time: `2025-03-${String((i % 28) + 1).padStart(2, '0')}`, open: close, high: close, low: close, close, volume: 1000 }
    })
    const t = computeTechnicals(bars)
    expect(t.resistance.some(r => r.price === 120)).toBe(true)
    expect(t.support.some(s => s.price === 80)).toBe(true)
    const res = t.resistance.find(r => r.price === 120)!
    expect(res.distancePct).toBeCloseTo(20, 2) // 120 is 20% above the last close of 100
  })

  it('nulls the long-window indicators and sets a note on short histories, never NaN', () => {
    const t = computeTechnicals(ascending(10))
    expect(t.macd.line).toBeNull()
    expect(t.macd.cross).toBeNull()
    expect(t.atr14).toBeNull()
    expect(t.bollinger.upper).toBeNull()
    expect(t.stochastic.k).toBeNull()
    expect(t.note).toBeTruthy()
    expect(JSON.stringify(t)).not.toContain('NaN')
  })

  it('handles a flat series and zero volume without NaN', () => {
    const flat = Array.from({ length: 40 }, (_, i) => ({
      time: `2025-04-${String((i % 28) + 1).padStart(2, '0')}`, open: 100, high: 100, low: 100, close: 100, volume: 0,
    }))
    const t = computeTechnicals(flat)
    expect(t.atr14).toBe(0)
    expect(t.stochastic.k).toBe(50)
    expect(t.bollinger.percentB).toBeNull() // zero-width band
    expect(t.volumeVsAvg20).toBeNull() // zero average volume
    expect(t.obv.value).toBe(0)
    expect(t.obv.trend20).toBe('flat')
    expect(JSON.stringify(t)).not.toContain('NaN')
  })

  it('returns empty extended fields for empty input', () => {
    const t = computeTechnicals([])
    expect(t.macd).toEqual({ line: null, signal: null, histogram: null, cross: null })
    expect(t.signals).toEqual([])
    expect(t.support).toEqual([])
    expect(t.resistance).toEqual([])
  })
})
