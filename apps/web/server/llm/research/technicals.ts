import type { DailyBar } from '../../lib/yahoo'

/**
 * A lightweight, deterministic technicals snapshot computed from Yahoo daily
 * bars. Pure and side-effect free so it can be unit-tested without network.
 * Every field is nullable — when there aren't enough bars for a window we
 * return null rather than fabricating a value.
 */
export interface TechnicalsSnapshot {
  asOf: string | null
  lastClose: number | null
  sma20: number | null
  sma50: number | null
  sma200: number | null
  high52w: number | null
  low52w: number | null
  pctFrom52wHigh: number | null // <= 0: at/below the high
  pctFrom52wLow: number | null // >= 0: at/above the low
  rsi14: number | null
  return1m: number | null // percent
  return3m: number | null
  return6m: number | null
  return1y: number | null
  avgVolume20: number | null
  trend: 'up' | 'down' | 'sideways' | null
}

const TRADING_DAYS = { m1: 21, m3: 63, m6: 126, y1: 252 } as const

function sma(closes: number[], window: number): number | null {
  if (closes.length < window) return null
  const slice = closes.slice(-window)
  return slice.reduce((a, b) => a + b, 0) / window
}

function trailingReturn(closes: number[], lookback: number): number | null {
  if (closes.length <= lookback) return null
  const now = closes[closes.length - 1]!
  const then = closes[closes.length - 1 - lookback]!
  if (!then) return null
  return ((now - then) / then) * 100
}

// Wilder's RSI over the last `period` deltas.
function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  const recent = closes.slice(-(period + 1))
  let gains = 0
  let losses = 0
  for (let i = 1; i < recent.length; i++) {
    const delta = recent[i]! - recent[i - 1]!
    if (delta >= 0) gains += delta
    else losses -= delta
  }
  const avgGain = gains / period
  const avgLoss = losses / period
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export function computeTechnicals(bars: DailyBar[]): TechnicalsSnapshot {
  const empty: TechnicalsSnapshot = {
    asOf: null, lastClose: null, sma20: null, sma50: null, sma200: null,
    high52w: null, low52w: null, pctFrom52wHigh: null, pctFrom52wLow: null,
    rsi14: null, return1m: null, return3m: null, return6m: null, return1y: null,
    avgVolume20: null, trend: null,
  }
  if (!bars.length) return empty

  const closes = bars.map(b => b.close)
  const lastClose = closes[closes.length - 1]!
  const last = bars[bars.length - 1]!

  const window52w = bars.slice(-TRADING_DAYS.y1)
  const high52w = Math.max(...window52w.map(b => b.high))
  const low52w = Math.min(...window52w.map(b => b.low))

  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)
  const sma200 = sma(closes, 200)

  const vol20 = bars.length >= 20
    ? bars.slice(-20).reduce((a, b) => a + b.volume, 0) / 20
    : null

  let trend: TechnicalsSnapshot['trend'] = null
  if (sma20 != null && sma50 != null && sma200 != null) {
    if (lastClose > sma20 && sma20 > sma50 && sma50 > sma200) trend = 'up'
    else if (lastClose < sma20 && sma20 < sma50 && sma50 < sma200) trend = 'down'
    else trend = 'sideways'
  }

  return {
    asOf: last.time,
    lastClose,
    sma20, sma50, sma200,
    high52w, low52w,
    pctFrom52wHigh: high52w ? ((lastClose - high52w) / high52w) * 100 : null,
    pctFrom52wLow: low52w ? ((lastClose - low52w) / low52w) * 100 : null,
    rsi14: rsi(closes, 14),
    return1m: trailingReturn(closes, TRADING_DAYS.m1),
    return3m: trailingReturn(closes, TRADING_DAYS.m3),
    return6m: trailingReturn(closes, TRADING_DAYS.m6),
    return1y: trailingReturn(closes, TRADING_DAYS.y1),
    avgVolume20: vol20,
    trend,
  }
}
