import { and, desc, eq, gte } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { portfolioSnapshots } from '../../db/schema'
import type { FullPortfolio } from './holdings'

/**
 * NET WORTH snapshot persistence + equity-curve math.
 *
 * Net worth comes from Ghostfolio only. There is no broker fallback on
 * purpose: a moomoo account total (live or paper) is not net worth, and one
 * such row in the curve corrupts every return and drawdown computed over it.
 * When Ghostfolio is unavailable the capture fails loudly and the curve simply
 * has no point for that day.
 *
 * Pure helpers (`buildSnapshotDetail`, `computePerformance`) are unit-tested
 * without a database; `capturePortfolioSnapshot` / `getPortfolioPerformance`
 * are the thin Drizzle-backed entry points the capture/performance routes and
 * the `portfolio_performance` chat tool call.
 */

export type SnapshotSource = 'auto' | 'manual'

export interface SnapshotPositionEntry {
  symbol: string
  qty: number
  price: number
  value: number
  currency: string | null
}

export interface SnapshotTotals {
  netWorth: number
  cash: number
  positionsValue: number
  /** Ghostfolio base currency the totals are denominated in (e.g. 'MYR'). */
  currency: string
}

export interface SnapshotDetail {
  totals: SnapshotTotals
  perAccount: FullPortfolio['accounts']
  positions: SnapshotPositionEntry[]
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Map the Ghostfolio aggregate into the row shape `portfolio_snapshots`
 * stores. Throws when Ghostfolio did not report a net worth; a broker total
 * is never substituted (see the module comment).
 */
export function buildSnapshotDetail(full: FullPortfolio | null): SnapshotDetail {
  if (full == null || full.ghostfolio_status !== 'ok' || full.net_worth_total == null) {
    throw new Error(
      'no net-worth data: Ghostfolio is unavailable. A moomoo account total is not net worth, so nothing was recorded.',
    )
  }
  const netWorth = full.net_worth_total
  return {
    totals: {
      netWorth: round2(netWorth),
      cash: round2(full.cash_total ?? 0),
      positionsValue: round2(full.positions_value ?? Math.max(0, netWorth - (full.cash_total ?? 0))),
      currency: full.net_worth_currency,
    },
    perAccount: full.accounts,
    positions: full.positions.map(p => ({
      symbol: p.symbol,
      qty: p.quantity,
      price: p.market_price,
      value: p.market_value,
      currency: p.currency || null,
    })),
  }
}

export interface CaptureResult {
  id: string | null
  capturedAt: string | null
  source: SnapshotSource
  skipped: boolean
  totals: SnapshotTotals | null
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Run the live portfolio fetch and persist one `portfolio_snapshots` row.
 * source='auto' is idempotent per UTC day: if an auto snapshot already exists
 * today, the call is a cheap no-op (so the cron loop can fire repeatedly).
 * Manual captures always insert.
 */
export async function capturePortfolioSnapshot(source: SnapshotSource): Promise<CaptureResult> {
  const db = getDb()
  if (source === 'auto') {
    const existing = await db
      .select({ id: portfolioSnapshots.id, capturedAt: portfolioSnapshots.capturedAt })
      .from(portfolioSnapshots)
      .where(and(
        eq(portfolioSnapshots.source, 'auto'),
        gte(portfolioSnapshots.capturedAt, startOfUtcDay(new Date())),
      ))
      .limit(1)
    if (existing[0]) {
      return {
        id: existing[0].id,
        capturedAt: existing[0].capturedAt.toISOString(),
        source,
        skipped: true,
        totals: null,
      }
    }
  }

  // Raw (uncached) fetch on purpose — recorded history must never be stale.
  const { getFullPortfolio } = await import('./holdings')
  const detail = buildSnapshotDetail(await getFullPortfolio())

  const inserted = await db
    .insert(portfolioSnapshots)
    .values({
      source,
      currency: detail.totals.currency,
      netWorth: detail.totals.netWorth.toFixed(2),
      cash: detail.totals.cash.toFixed(2),
      positionsValue: detail.totals.positionsValue.toFixed(2),
      perAccount: detail.perAccount,
      positions: detail.positions,
    })
    .returning({ id: portfolioSnapshots.id, capturedAt: portfolioSnapshots.capturedAt })
  const row = inserted[0]
  return {
    id: row?.id ?? null,
    capturedAt: row?.capturedAt ? row.capturedAt.toISOString() : null,
    source,
    skipped: false,
    totals: detail.totals,
  }
}

export interface EquityPoint {
  t: string
  source: string
  netWorth: number
  cash: number
  positionsValue: number
  currency: string | null
}

export interface PerformanceStats {
  count: number
  firstAt: string | null
  lastAt: string | null
  currency: string | null
  totalReturnPct: number | null
  maxDrawdownPct: number | null
  periodReturns: { d1: number | null; d7: number | null; d30: number | null }
}

export interface PortfolioPerformance {
  series: EquityPoint[]
  stats: PerformanceStats
}

const DAY_MS = 24 * 60 * 60 * 1000

function periodReturn(series: EquityPoint[], last: EquityPoint, days: number): number | null {
  const base = periodBaseline(series, last.t, days)
  return base && base.netWorth > 0 ? ((last.netWorth / base.netWorth) - 1) * 100 : null
}

/**
 * The snapshot `days` before `lastIso`, allowing the daily capture to land a
 * few minutes later than the day before. Strictly requiring `<= cutoff`
 * turned a 1-day return into a 2-day return whenever today's capture ran
 * earlier in the day than yesterday's. Tolerance is half a day, capped at
 * half the window so 1-day and 7-day baselines cannot collide.
 */
export function periodBaseline<T extends { t: string }>(series: T[], lastIso: string, days: number): T | null {
  const cutoff = new Date(lastIso).getTime() - days * DAY_MS
  const tolerance = Math.min(DAY_MS / 2, (days * DAY_MS) / 2)
  for (let i = series.length - 1; i >= 0; i--) {
    const point = series[i]!
    const t = new Date(point.t).getTime()
    if (t <= cutoff + tolerance && t < new Date(lastIso).getTime()) return point
  }
  return null
}

/**
 * Equity-curve stats over chronologically ordered snapshot points. Simple by
 * design: total return vs the first snapshot, worst peak-to-trough drawdown,
 * and 1/7/30-day returns measured against the closest snapshot at least that
 * old. Non-finite rows are dropped rather than corrupting the math, and so is
 * every row not denominated in the newest row's currency: older captures once
 * fell back to a broker total with no currency, and a ratio across two units
 * is not a return.
 */
export function computePerformance(points: EquityPoint[]): PortfolioPerformance {
  const sorted = points
    .filter(p => Number.isFinite(p.netWorth))
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
  const currency = sorted[sorted.length - 1]?.currency ?? null
  const series = currency == null ? [] : sorted.filter(p => p.currency === currency)

  const first = series[0]
  const last = series[series.length - 1]
  if (!first || !last) {
    return {
      series: [],
      stats: {
        count: 0,
        firstAt: null,
        lastAt: null,
        currency: null,
        totalReturnPct: null,
        maxDrawdownPct: null,
        periodReturns: { d1: null, d7: null, d30: null },
      },
    }
  }

  let peak = Number.NEGATIVE_INFINITY
  let maxDrawdownPct = 0
  for (const point of series) {
    peak = Math.max(peak, point.netWorth)
    if (peak > 0) {
      const dd = ((point.netWorth / peak) - 1) * 100
      maxDrawdownPct = Math.min(maxDrawdownPct, dd)
    }
  }

  return {
    series,
    stats: {
      count: series.length,
      firstAt: first.t,
      lastAt: last.t,
      currency: last.currency,
      totalReturnPct: first.netWorth > 0 ? ((last.netWorth / first.netWorth) - 1) * 100 : null,
      maxDrawdownPct,
      periodReturns: {
        d1: periodReturn(series, last, 1),
        d7: periodReturn(series, last, 7),
        d30: periodReturn(series, last, 30),
      },
    },
  }
}

/** Load snapshots for the last `days` days and derive the equity curve. */
export async function getPortfolioPerformance(opts: { days?: number } = {}): Promise<PortfolioPerformance> {
  const days = Math.max(1, Math.min(3650, Math.floor(opts.days ?? 365)))
  const db = getDb()
  const rows = await db
    .select({
      capturedAt: portfolioSnapshots.capturedAt,
      source: portfolioSnapshots.source,
      currency: portfolioSnapshots.currency,
      netWorth: portfolioSnapshots.netWorth,
      cash: portfolioSnapshots.cash,
      positionsValue: portfolioSnapshots.positionsValue,
    })
    .from(portfolioSnapshots)
    .where(gte(portfolioSnapshots.capturedAt, new Date(Date.now() - days * DAY_MS)))
    .orderBy(desc(portfolioSnapshots.capturedAt))
    .limit(2000)
  return computePerformance(rows.map(r => ({
    t: r.capturedAt.toISOString(),
    source: r.source,
    netWorth: Number(r.netWorth),
    cash: Number(r.cash),
    positionsValue: Number(r.positionsValue),
    currency: r.currency,
  })))
}
