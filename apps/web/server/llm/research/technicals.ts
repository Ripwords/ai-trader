import type { DailyBar } from '../../lib/yahoo'
import {
  round, smaSeries, ema, macdSeries, bollinger, atrWilder,
  stochastic, obvSeries, detectCross, findPivots,
} from './indicators'

/**
 * A lightweight, deterministic technicals snapshot computed from Yahoo daily
 * bars. Pure and side-effect free so it can be unit-tested without network.
 * Every field is nullable — when there aren't enough bars for a window we
 * return null rather than fabricating a value.
 */
export interface TechnicalSignal {
  indicator: string
  reading: string
  signal: 'bullish' | 'bearish' | 'neutral'
  detail: string
}

export interface PivotLevel {
  price: number
  time: string
  /** Percent from the last close to this level (positive = above price). */
  distancePct: number | null
}

export interface MacdSnapshot {
  line: number | null
  signal: number | null
  histogram: number | null
  /** Line/signal cross within the last CROSS_WINDOW bars. */
  cross: 'bullish' | 'bearish' | null
}

export interface BollingerSnapshot {
  upper: number | null
  mid: number | null
  lower: number | null
  percentB: number | null
  bandwidth: number | null
}

export interface StochasticSnapshot {
  k: number | null
  d: number | null
  reading: 'overbought' | 'oversold' | 'neutral' | null
}

export interface ObvSnapshot {
  value: number | null
  /** OBV now vs 20 bars ago. */
  trend20: 'up' | 'down' | 'flat' | null
}

export interface SmaCrossSnapshot {
  /** SMA50 crossed above SMA200 within the last `withinBars` bars. */
  golden: boolean
  /** SMA50 crossed below SMA200 within the last `withinBars` bars. */
  death: boolean
  withinBars: number
}

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
  // --- extended indicators (all nullable; additive, never breaking) -------
  ema12: number | null
  ema26: number | null
  macd: MacdSnapshot
  bollinger: BollingerSnapshot
  atr14: number | null
  /** ATR(14) as a percent of the last close. */
  atrPct: number | null
  stochastic: StochasticSnapshot
  obv: ObvSnapshot
  /** Last bar's volume as a multiple of the 20-day average volume. */
  volumeVsAvg20: number | null
  smaCross: SmaCrossSnapshot
  /** Most recent fractal swing-low pivot levels (up to 3). */
  support: PivotLevel[]
  /** Most recent fractal swing-high pivot levels (up to 3). */
  resistance: PivotLevel[]
  /** Deterministic per-indicator readings — rules, not predictions. */
  signals: TechnicalSignal[]
  /** Set when history is too short for some indicators. */
  note: string | null
}

const TRADING_DAYS = { m1: 21, m3: 63, m6: 126, y1: 252 } as const

/** Lookback (bars) for MACD line/signal and SMA50/200 cross detection. */
const CROSS_WINDOW = 10
const PIVOT_WINDOW = 5
const PIVOT_COUNT = 3

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

function emptySnapshot(): TechnicalsSnapshot {
  return {
    asOf: null, lastClose: null, sma20: null, sma50: null, sma200: null,
    high52w: null, low52w: null, pctFrom52wHigh: null, pctFrom52wLow: null,
    rsi14: null, return1m: null, return3m: null, return6m: null, return1y: null,
    avgVolume20: null, trend: null,
    ema12: null, ema26: null,
    macd: { line: null, signal: null, histogram: null, cross: null },
    bollinger: { upper: null, mid: null, lower: null, percentB: null, bandwidth: null },
    atr14: null, atrPct: null,
    stochastic: { k: null, d: null, reading: null },
    obv: { value: null, trend20: null },
    volumeVsAvg20: null,
    smaCross: { golden: false, death: false, withinBars: CROSS_WINDOW },
    support: [], resistance: [],
    signals: [],
    note: null,
  }
}

function fmt(v: number | null, dp = 2): string {
  return v == null ? '--' : v.toFixed(dp)
}

/** Deterministic per-indicator readings. Rules only — no predictive scores. */
function buildSignals(s: TechnicalsSnapshot): TechnicalSignal[] {
  const signals: TechnicalSignal[] = []

  if (s.trend != null && s.lastClose != null) {
    signals.push({
      indicator: 'trend',
      reading: s.trend === 'up' ? 'uptrend (SMA ladder aligned)' : s.trend === 'down' ? 'downtrend (SMA ladder aligned)' : 'sideways / mixed SMA ladder',
      signal: s.trend === 'up' ? 'bullish' : s.trend === 'down' ? 'bearish' : 'neutral',
      detail: `close ${fmt(s.lastClose)} vs SMA20 ${fmt(s.sma20)} / SMA50 ${fmt(s.sma50)} / SMA200 ${fmt(s.sma200)}`,
    })
  }

  if (s.smaCross.golden || s.smaCross.death) {
    signals.push({
      indicator: 'sma_cross',
      reading: s.smaCross.golden ? 'golden cross' : 'death cross',
      signal: s.smaCross.golden ? 'bullish' : 'bearish',
      detail: `SMA50 crossed ${s.smaCross.golden ? 'above' : 'below'} SMA200 within the last ${s.smaCross.withinBars} bars`,
    })
  }

  if (s.macd.line != null && s.macd.signal != null && s.macd.histogram != null) {
    const cross = s.macd.cross
    signals.push({
      indicator: 'macd',
      reading: cross ? `${cross} cross` : s.macd.histogram > 0 ? 'histogram positive' : s.macd.histogram < 0 ? 'histogram negative' : 'flat',
      signal: cross ?? (s.macd.histogram > 0 ? 'bullish' : s.macd.histogram < 0 ? 'bearish' : 'neutral'),
      detail: `line ${fmt(s.macd.line, 3)}, signal ${fmt(s.macd.signal, 3)}, histogram ${fmt(s.macd.histogram, 3)}`,
    })
  }

  if (s.rsi14 != null) {
    const overbought = s.rsi14 >= 70
    const oversold = s.rsi14 <= 30
    signals.push({
      indicator: 'rsi14',
      reading: overbought ? `overbought (${fmt(s.rsi14, 1)})` : oversold ? `oversold (${fmt(s.rsi14, 1)})` : `neutral (${fmt(s.rsi14, 1)})`,
      signal: overbought ? 'bearish' : oversold ? 'bullish' : 'neutral',
      detail: 'Wilder RSI(14); >=70 overbought, <=30 oversold',
    })
  }

  if (s.bollinger.percentB != null) {
    const pb = s.bollinger.percentB
    signals.push({
      indicator: 'bollinger',
      reading: pb > 1 ? 'close above upper band' : pb < 0 ? 'close below lower band' : 'inside bands',
      signal: pb > 1 ? 'bearish' : pb < 0 ? 'bullish' : 'neutral',
      detail: `%B ${fmt(pb, 2)}, bandwidth ${fmt(s.bollinger.bandwidth, 3)}`,
    })
  }

  if (s.stochastic.reading != null) {
    signals.push({
      indicator: 'stochastic',
      reading: `${s.stochastic.reading} (K ${fmt(s.stochastic.k, 1)}, D ${fmt(s.stochastic.d, 1)})`,
      signal: s.stochastic.reading === 'overbought' ? 'bearish' : s.stochastic.reading === 'oversold' ? 'bullish' : 'neutral',
      detail: '%K(14)/%D(3); >=80 overbought, <=20 oversold',
    })
  }

  if (s.obv.trend20 != null) {
    signals.push({
      indicator: 'obv',
      reading: s.obv.trend20 === 'up' ? 'rising' : s.obv.trend20 === 'down' ? 'falling' : 'flat',
      signal: s.obv.trend20 === 'up' ? 'bullish' : s.obv.trend20 === 'down' ? 'bearish' : 'neutral',
      detail: 'on-balance volume vs 20 bars ago',
    })
  }

  if (s.volumeVsAvg20 != null) {
    signals.push({
      indicator: 'volume',
      reading: `${fmt(s.volumeVsAvg20, 2)}x 20-day average`,
      signal: 'neutral',
      detail: s.volumeVsAvg20 >= 1.5 ? 'elevated volume' : s.volumeVsAvg20 <= 0.5 ? 'light volume' : 'normal volume',
    })
  }

  return signals
}

export function computeTechnicals(bars: DailyBar[]): TechnicalsSnapshot {
  const snapshot = emptySnapshot()
  if (!bars.length) return snapshot

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

  // --- extended indicators ------------------------------------------------
  const macd = macdSeries(closes)
  const macdLast = macd.line[macd.line.length - 1] ?? null
  const macdSignalLast = macd.signal[macd.signal.length - 1] ?? null
  const macdHistLast = macd.histogram[macd.histogram.length - 1] ?? null

  const boll = bollinger(closes, 20, 2)
  const atr = atrWilder(bars, 14)
  const stoch = stochastic(bars, 14, 3)
  const stochReading: StochasticSnapshot['reading'] =
    stoch.k == null ? null : stoch.k >= 80 ? 'overbought' : stoch.k <= 20 ? 'oversold' : 'neutral'

  const obv = obvSeries(bars)
  const obvLast = obv.length ? obv[obv.length - 1]! : null
  let obvTrend20: ObvSnapshot['trend20'] = null
  if (obv.length > 20) {
    const then = obv[obv.length - 1 - 20]!
    obvTrend20 = obvLast! > then ? 'up' : obvLast! < then ? 'down' : 'flat'
  }

  const lastVolume = last.volume
  const volumeVsAvg20 = vol20 != null && vol20 > 0 ? lastVolume / vol20 : null

  const sma50Series = smaSeries(closes, 50)
  const sma200Series = smaSeries(closes, 200)
  const smaCrossKind = detectCross(sma50Series, sma200Series, CROSS_WINDOW)

  const pivots = findPivots(bars, PIVOT_WINDOW, PIVOT_COUNT)
  const toLevel = (p: { price: number; time: string }): PivotLevel => ({
    price: round(p.price, 4)!,
    time: p.time,
    distancePct: lastClose ? round(((p.price - lastClose) / lastClose) * 100, 2) : null,
  })

  const shortHistory = macdLast == null || sma200 == null || atr == null
  const note = shortHistory
    ? `short history (${bars.length} bars) — long-window indicators (SMA200/MACD/ATR) may be null`
    : null

  const result: TechnicalsSnapshot = {
    ...snapshot,
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
    ema12: round(ema(closes, 12), 4),
    ema26: round(ema(closes, 26), 4),
    macd: {
      line: round(macdLast, 4),
      signal: round(macdSignalLast, 4),
      histogram: round(macdHistLast, 4),
      cross: detectCross(macd.line, macd.signal, CROSS_WINDOW),
    },
    bollinger: {
      upper: round(boll?.upper ?? null, 4),
      mid: round(boll?.mid ?? null, 4),
      lower: round(boll?.lower ?? null, 4),
      percentB: round(boll?.percentB ?? null, 4),
      bandwidth: round(boll?.bandwidth ?? null, 4),
    },
    atr14: round(atr, 4),
    atrPct: lastClose ? round(atr != null ? (atr / lastClose) * 100 : null, 2) : null,
    stochastic: { k: round(stoch.k, 2), d: round(stoch.d, 2), reading: stochReading },
    obv: { value: round(obvLast, 0), trend20: obvTrend20 },
    volumeVsAvg20: round(volumeVsAvg20, 2),
    smaCross: { golden: smaCrossKind === 'bullish', death: smaCrossKind === 'bearish', withinBars: CROSS_WINDOW },
    support: pivots.lows.map(toLevel),
    resistance: pivots.highs.map(toLevel),
    signals: [],
    note,
  }
  result.signals = buildSignals(result)
  return result
}
