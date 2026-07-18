import { describe, it, expect } from 'vitest'
import {
  round, smaSeries, emaSeries, ema, macdSeries, bollinger, atrWilder,
  stochastic, obvSeries, detectCross, findPivots,
} from '../../server/llm/research/indicators'
import type { DailyBar } from '../../server/lib/yahoo'

function bar(close: number, over: Partial<DailyBar> = {}): DailyBar {
  return { time: '2025-01-01', open: close, high: close, low: close, close, volume: 1000, ...over }
}

describe('round', () => {
  it('rounds to the requested decimal places', () => {
    expect(round(1.23456, 2)).toBe(1.23)
    expect(round(349.5, 4)).toBe(349.5)
  })
  it('maps non-finite and nullish input to null (never NaN in output)', () => {
    expect(round(NaN, 2)).toBeNull()
    expect(round(Infinity, 2)).toBeNull()
    expect(round(null, 2)).toBeNull()
    expect(round(undefined, 2)).toBeNull()
  })
})

describe('smaSeries', () => {
  it('computes a rolling mean with null padding', () => {
    expect(smaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })
  it('returns all nulls when there are fewer values than the window', () => {
    expect(smaSeries([1, 2], 3)).toEqual([null, null])
  })
})

describe('emaSeries / ema', () => {
  it('seeds with the SMA and applies the standard multiplier', () => {
    // period 3 -> k = 0.5; seed at idx2 = mean(1,2,3) = 2; then 3, 4
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4)
  })
  it('returns nulls for short input', () => {
    expect(emaSeries([1, 2], 3)).toEqual([null, null])
    expect(ema([1, 2], 3)).toBeNull()
  })
})

describe('macdSeries', () => {
  it('matches hand-computed values for small periods', () => {
    // fast=2: [null, 1.5, 2.5, 3.5, 4.5]; slow=3: [null, null, 2, 3, 4]
    const { line, signal, histogram } = macdSeries([1, 2, 3, 4, 5], 2, 3, 2)
    expect(line).toEqual([null, null, 0.5, 0.5, 0.5])
    // signal = EMA(2) over the defined line values [0.5, 0.5, 0.5]
    expect(signal).toEqual([null, null, null, 0.5, 0.5])
    expect(histogram).toEqual([null, null, null, 0, 0])
  })
  it('is exactly zero for a constant series', () => {
    const closes = Array.from({ length: 60 }, () => 100)
    const { line, signal, histogram } = macdSeries(closes)
    expect(line[59]).toBe(0)
    expect(signal[59]).toBe(0)
    expect(histogram[59]).toBe(0)
  })
})

describe('bollinger', () => {
  it('matches a hand-computed sd=2 window', () => {
    // mean 5, population sd 2 -> upper 9, lower 1; last close 9 -> %B 1
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2)!
    expect(b.mid).toBe(5)
    expect(b.upper).toBe(9)
    expect(b.lower).toBe(1)
    expect(b.percentB).toBe(1)
    expect(b.bandwidth).toBeCloseTo(1.6, 10)
  })
  it('degrades a flat window to a zero-width band without NaN', () => {
    const b = bollinger([5, 5, 5, 5], 4, 2)!
    expect(b.upper).toBe(5)
    expect(b.lower).toBe(5)
    expect(b.percentB).toBeNull()
    expect(b.bandwidth).toBe(0)
  })
  it('returns null when there are too few closes', () => {
    expect(bollinger([1, 2], 20, 2)).toBeNull()
  })
})

describe('atrWilder', () => {
  it('matches a hand-computed Wilder smoothing', () => {
    const bars: DailyBar[] = [
      bar(11, { high: 12, low: 10 }),
      bar(12, { high: 13, low: 11 }), // TR 2
      bar(13, { high: 14, low: 12 }), // TR 2 -> seed ATR(2) = 2
      bar(15, { high: 17, low: 13 }), // TR 4 -> (2*1 + 4)/2 = 3
    ]
    expect(atrWilder(bars, 2)).toBe(3)
  })
  it('is zero for a flat series', () => {
    expect(atrWilder(Array.from({ length: 20 }, () => bar(100)), 14)).toBe(0)
  })
  it('returns null with fewer than period+1 bars', () => {
    expect(atrWilder([bar(1), bar(2)], 14)).toBeNull()
  })
})

describe('stochastic', () => {
  it('places the close inside the high/low range', () => {
    // HH 20, LL 10, close 15 -> %K 50
    const s = stochastic([bar(10), bar(20), bar(15)], 3, 1)
    expect(s.k).toBe(50)
    expect(s.d).toBe(50)
  })
  it('uses 50 for a flat window instead of NaN', () => {
    const s = stochastic(Array.from({ length: 20 }, () => bar(7)), 14, 3)
    expect(s.k).toBe(50)
    expect(s.d).toBe(50)
  })
  it('returns nulls when there are not enough bars for %K or %D', () => {
    expect(stochastic([bar(1)], 14, 3)).toEqual({ k: null, d: null })
    // enough for one %K but not for a 3-period %D
    expect(stochastic([bar(10), bar(20), bar(15)], 3, 3).d).toBeNull()
  })
})

describe('obvSeries', () => {
  it('accumulates signed volume from close-to-close moves', () => {
    const bars = [
      bar(10, { volume: 100 }),
      bar(11, { volume: 200 }),
      bar(10, { volume: 300 }),
      bar(10, { volume: 400 }),
      bar(12, { volume: 500 }),
    ]
    expect(obvSeries(bars)).toEqual([0, 200, -100, -100, 400])
  })
  it('stays flat at zero volume', () => {
    expect(obvSeries([bar(1, { volume: 0 }), bar(2, { volume: 0 })])).toEqual([0, 0])
  })
})

describe('detectCross', () => {
  it('flags a bullish cross when a moves above b', () => {
    expect(detectCross([1, 1, 3], [2, 2, 2], 5)).toBe('bullish')
  })
  it('flags a bearish cross when a moves below b', () => {
    expect(detectCross([3, 3, 1], [2, 2, 2], 5)).toBe('bearish')
  })
  it('ignores crosses outside the lookback window', () => {
    const a = [1, 3, 3, 3]
    const b = [2, 2, 2, 2]
    expect(detectCross(a, b, 2)).toBeNull()
    expect(detectCross(a, b, 3)).toBe('bullish')
  })
  it('returns null when either side is null or there is no cross', () => {
    expect(detectCross([null, 1], [null, 2], 5)).toBeNull()
    expect(detectCross([3, 3, 3], [2, 2, 2], 5)).toBeNull()
  })
})

describe('findPivots', () => {
  it('finds fractal swing highs and lows over a 5-bar window', () => {
    const bars: DailyBar[] = [
      bar(10, { high: 10, low: 9, time: '2025-01-01' }),
      bar(11, { high: 11, low: 8, time: '2025-01-02' }),
      bar(15, { high: 15, low: 5, time: '2025-01-03' }),
      bar(11, { high: 11, low: 8, time: '2025-01-04' }),
      bar(10, { high: 10, low: 9, time: '2025-01-05' }),
    ]
    const p = findPivots(bars, 5, 3)
    expect(p.highs).toEqual([{ price: 15, time: '2025-01-03' }])
    expect(p.lows).toEqual([{ price: 5, time: '2025-01-03' }])
  })
  it('finds no pivots in a monotonic series', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(100 + i))
    const p = findPivots(bars, 5, 3)
    expect(p.highs).toEqual([])
    expect(p.lows).toEqual([])
  })
  it('keeps only the most recent `count` pivots of each kind', () => {
    // zig-zag: peaks every 4 bars
    const bars: DailyBar[] = []
    for (let i = 0; i < 40; i++) {
      const phase = i % 8
      const v = phase < 4 ? 100 + phase * 5 : 100 + (8 - phase) * 5
      bars.push(bar(v, { time: `2025-02-${String(i + 1).padStart(2, '0')}` }))
    }
    const p = findPivots(bars, 5, 3)
    expect(p.highs.length).toBe(3)
    expect(p.lows.length).toBeLessThanOrEqual(3)
  })
})
