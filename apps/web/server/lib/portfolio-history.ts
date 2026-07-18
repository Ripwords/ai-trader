import { and, desc, eq, gte } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { portfolioSnapshots } from '../../db/schema'
import type { FullPortfolio } from './holdings'
import type { PortfolioSnapshot } from './portfolio-snapshot'

/**
 * Portfolio snapshot persistence + equity-curve math.
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
  // Base currency of the totals (e.g. 'MYR' from Ghostfolio). null when only
  // the moomoo fallback was available — moomoo's resolver shape carries no
  // currency, and we never invent one.
  currency: string | null
}

export interface SnapshotDetail {
  totals: SnapshotTotals
  perAccount: FullPortfolio['accounts']
  positions: SnapshotPositionEntry[]
  // The live resolver's own shape ({cash, total_value, positions}) preserved
  // verbatim so stored rows stay comparable with resolvePortfolio() output.
  resolver: PortfolioSnapshot | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Map the cross-broker portfolio (plus the best-effort live-resolver result)
 * into the row shape `portfolio_snapshots` stores. Prefers the Ghostfolio
 * aggregate when it reported a net worth; otherwise falls back to the live
 * resolver totals and the moomoo position slices. Throws when neither source
 * produced totals — a snapshot of nothing would poison the equity curve.
 */
export function buildSnapshotDetail(full: FullPortfolio | null, resolver: PortfolioSnapshot | null): SnapshotDetail {
  const ghostfolioOk = full != null && full.ghostfolio_status === 'ok' && full.net_worth_total != null
  if (ghostfolioOk) {
    return {
      totals: {
        netWorth: round2(full.net_worth_total ?? 0),
        cash: round2(full.cash_total ?? 0),
        positionsValue: round2(full.positions_value ?? Math.max(0, (full.net_worth_total ?? 0) - (full.cash_total ?? 0))),
        currency: full.net_worth_currency || null,
      },
      perAccount: full.accounts,
      positions: full.positions.map(p => ({
        symbol: p.symbol,
        qty: p.quantity,
        price: p.market_price,
        value: p.market_value,
        currency: p.currency || null,
      })),
      resolver,
    }
  }
  if (resolver) {
    const moomooSlices = [...(full?.moomoo_paper ?? []), ...(full?.moomoo_live ?? [])]
    return {
      totals: {
        netWorth: round2(resolver.total_value),
        cash: round2(resolver.cash),
        positionsValue: round2(Math.max(0, resolver.total_value - resolver.cash)),
        currency: null,
      },
      perAccount: full?.accounts ?? [],
      positions: moomooSlices.map(p => ({
        symbol: p.symbol,
        qty: p.quantity,
        price: p.quantity > 0 ? round2(p.market_value / p.quantity) : 0,
        value: p.market_value,
        currency: p.currency,
      })),
      resolver,
    }
  }
  throw new Error('no portfolio data — both the Ghostfolio aggregate and the moomoo resolver are unavailable')
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

  // Raw (uncached) fetches on purpose — recorded history must never be stale.
  const { getFullPortfolio } = await import('./holdings')
  const { resolvePortfolio } = await import('./portfolio-snapshot')
  let full: FullPortfolio | null = null
  try {
    full = await getFullPortfolio()
  } catch (err) {
    console.warn('[portfolio-history] full portfolio fetch failed:', err instanceof Error ? err.message : err)
  }
  let resolver: PortfolioSnapshot | null = null
  try {
    resolver = await resolvePortfolio()
  } catch (err) {
    console.warn('[portfolio-history] live resolver unavailable:', err instanceof Error ? err.message : err)
  }
  const detail = buildSnapshotDetail(full, resolver)

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
      resolver: detail.resolver,
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
  const cutoff = new Date(last.t).getTime() - days * DAY_MS
  // Latest point that is at least `days` older than the newest snapshot.
  for (let i = series.length - 1; i >= 0; i--) {
    const point = series[i]!
    if (new Date(point.t).getTime() <= cutoff) {
      return point.netWorth > 0 ? ((last.netWorth / point.netWorth) - 1) * 100 : null
    }
  }
  return null
}

/**
 * Equity-curve stats over chronologically ordered snapshot points. Simple by
 * design: total return vs the first snapshot, worst peak-to-trough drawdown,
 * and 1/7/30-day returns measured against the closest snapshot at least that
 * old. Non-finite rows are dropped rather than corrupting the math.
 */
export function computePerformance(points: EquityPoint[]): PortfolioPerformance {
  const series = points
    .filter(p => Number.isFinite(p.netWorth))
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())

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
