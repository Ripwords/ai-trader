import type { DailyBar } from '../../lib/yahoo'

/**
 * Pure, deterministic indicator math over daily OHLCV bars. Every function is
 * side-effect free and returns null (never NaN) when a value cannot be
 * computed from the available history. Composed into a TechnicalsSnapshot by
 * `computeTechnicals` in ./technicals.
 */

/** Round to `dp` decimal places, mapping non-finite/nullish input to null. */
export function round(v: number | null | undefined, dp = 4): number | null {
  if (v == null || !Number.isFinite(v)) return null
  const f = 10 ** dp
  return Math.round(v * f) / f
}

/** Rolling simple moving average; null-padded until the window fills. */
export function smaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null)
  if (period <= 0 || values.length < period) return out
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= period) sum -= values[i - period]!
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

/** EMA seeded with the SMA of the first `period` values, k = 2/(period+1). */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(values.length).fill(null)
  if (period <= 0 || values.length < period) return out
  const k = 2 / (period + 1)
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]!
  let prev = seed / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = prev + (values[i]! - prev) * k
    out[i] = prev
  }
  return out
}

export function ema(values: number[], period: number): number | null {
  const s = emaSeries(values, period)
  return s.length ? s[s.length - 1]! : null
}

export interface MacdSeriesResult {
  line: (number | null)[]
  signal: (number | null)[]
  histogram: (number | null)[]
}

/** MACD line = EMA(fast) - EMA(slow); signal = EMA(signalPeriod) of the line. */
export function macdSeries(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeriesResult {
  const fastE = emaSeries(closes, fast)
  const slowE = emaSeries(closes, slow)
  const line: (number | null)[] = closes.map((_, i) =>
    fastE[i] != null && slowE[i] != null ? fastE[i]! - slowE[i]! : null)
  const signal: (number | null)[] = new Array<number | null>(closes.length).fill(null)
  const firstIdx = line.findIndex(v => v != null)
  if (firstIdx !== -1) {
    const defined = line.slice(firstIdx) as number[]
    const sig = emaSeries(defined, signalPeriod)
    for (let i = 0; i < sig.length; i++) signal[firstIdx + i] = sig[i] ?? null
  }
  const histogram: (number | null)[] = closes.map((_, i) =>
    line[i] != null && signal[i] != null ? line[i]! - signal[i]! : null)
  return { line, signal, histogram }
}

export interface BollingerBands {
  upper: number
  mid: number
  lower: number
  /** (last - lower) / (upper - lower); null when the band has zero width. */
  percentB: number | null
  /** (upper - lower) / mid; null when mid is zero. */
  bandwidth: number | null
}

/** Bollinger bands over the trailing `period` closes (population std dev). */
export function bollinger(closes: number[], period = 20, mult = 2): BollingerBands | null {
  if (closes.length < period) return null
  const slice = closes.slice(-period)
  const mid = slice.reduce((a, b) => a + b, 0) / period
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period
  const sd = Math.sqrt(variance)
  const upper = mid + mult * sd
  const lower = mid - mult * sd
  const last = closes[closes.length - 1]!
  const width = upper - lower
  return {
    upper,
    mid,
    lower,
    percentB: width > 0 ? (last - lower) / width : null,
    bandwidth: mid !== 0 ? width / mid : null,
  }
}

/** Wilder's ATR: seed with the mean of the first `period` true ranges. */
export function atrWilder(bars: DailyBar[], period = 14): number | null {
  if (bars.length < period + 1) return null
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!
    const prevClose = bars[i - 1]!.close
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)))
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period
  }
  return atr
}

/** Stochastic %K over `kPeriod` bars and %D = SMA(dPeriod) of %K. Flat window -> 50. */
export function stochastic(bars: DailyBar[], kPeriod = 14, dPeriod = 3): { k: number | null; d: number | null } {
  if (bars.length < kPeriod) return { k: null, d: null }
  const kSeries: number[] = []
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const window = bars.slice(i - kPeriod + 1, i + 1)
    const hh = Math.max(...window.map(b => b.high))
    const ll = Math.min(...window.map(b => b.low))
    const close = bars[i]!.close
    kSeries.push(hh === ll ? 50 : ((close - ll) / (hh - ll)) * 100)
  }
  const k = kSeries[kSeries.length - 1]!
  const d = kSeries.length >= dPeriod
    ? kSeries.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod
    : null
  return { k, d }
}

/** On-balance volume, starting at 0 on the first bar. */
export function obvSeries(bars: DailyBar[]): number[] {
  const out: number[] = []
  let obv = 0
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) {
      const delta = bars[i]!.close - bars[i - 1]!.close
      if (delta > 0) obv += bars[i]!.volume
      else if (delta < 0) obv -= bars[i]!.volume
    }
    out.push(obv)
  }
  return out
}

/**
 * Detect the most recent cross of series `a` through series `b` within the
 * last `withinBars` bars: 'bullish' when a moves above b, 'bearish' when a
 * moves below b. Pairs with nulls are skipped.
 */
export function detectCross(
  a: (number | null)[],
  b: (number | null)[],
  withinBars: number,
): 'bullish' | 'bearish' | null {
  const n = Math.min(a.length, b.length)
  const start = Math.max(1, n - withinBars)
  for (let i = n - 1; i >= start; i--) {
    if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue
    const cur = a[i]! - b[i]!
    const prev = a[i - 1]! - b[i - 1]!
    if (cur > 0 && prev <= 0) return 'bullish'
    if (cur < 0 && prev >= 0) return 'bearish'
  }
  return null
}

export interface Pivot { price: number; time: string }

/**
 * Fractal swing pivots: a bar is a swing high when its high strictly exceeds
 * the highs of the surrounding `window` bars (window/2 each side); swing lows
 * mirror that on lows. Returns the most recent `count` of each.
 */
export function findPivots(bars: DailyBar[], window = 5, count = 3): { highs: Pivot[]; lows: Pivot[] } {
  const half = Math.floor(window / 2)
  const highs: Pivot[] = []
  const lows: Pivot[] = []
  for (let i = half; i < bars.length - half; i++) {
    const b = bars[i]!
    let isHigh = true
    let isLow = true
    for (let j = i - half; j <= i + half; j++) {
      if (j === i) continue
      if (bars[j]!.high >= b.high) isHigh = false
      if (bars[j]!.low <= b.low) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) highs.push({ price: b.high, time: b.time })
    if (isLow) lows.push({ price: b.low, time: b.time })
  }
  return { highs: highs.slice(-count), lows: lows.slice(-count) }
}
