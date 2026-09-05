import { and, desc, eq, gte } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { investmentSnapshots } from '../../db/schema'
import type { InvestmentPortfolio } from './investment-portfolio'
import { periodBaseline } from './portfolio-history'

/**
 * Equity curve for the INVESTMENTS layer (moomoo live).
 *
 * Deliberately parallel to portfolio-history.ts but never shared with it: that
 * module tracks NET WORTH, this one tracks invested capital, and blending the
 * two is the bug this whole harness exists to prevent.
 *
 * One thing this layer does that the net-worth curve does not: it stores cost
 * basis next to market value. Market value rises when you deposit money or buy
 * more, so a value change is NOT a return. Calling a deposit "performance" is
 * the same class of error as calling a net-worth delta portfolio performance,
 * so the stats below expose flows explicitly instead of hiding them.
 */

export type SnapshotSource = 'auto' | 'manual'

export interface InvestmentSnapshotRow {
  reportingCurrency: string
  marketValue: number
  costBasis: number
  unrealizedPl: number
  dayChange: number | null
  dayChangePct: number | null
  byCurrency: InvestmentPortfolio['by_currency']
  positions: InvestmentPortfolio['positions']
  accounts: string[]
}

export interface InvestmentEquityPoint {
  t: string
  source: string
  currency: string
  marketValue: number
  costBasis: number
  unrealizedPl: number
  dayChange: number | null
  dayChangePct: number | null
}

export interface InvestmentPerformanceStats {
  count: number
  firstAt: string | null
  lastAt: string | null
  currency: string | null
  /**
   * Change in market value across the window. NOT a return — deposits,
   * withdrawals and new buys move this too. Read it together with
   * costBasisChangePct and flowsDetected.
   */
  valueChangePct: number | null
  /** Change in cost basis: non-zero means money moved in or out. */
  costBasisChangePct: number | null
  /** True when cost basis moved materially, i.e. valueChangePct includes flows. */
  flowsDetected: boolean
  /** Flow-neutral margin on cost at each end of the window. */
  unrealizedPlPctFirst: number | null
  unrealizedPlPctLast: number | null
  maxDrawdownPct: number | null
  periodReturns: { d1: number | null; d7: number | null; d30: number | null }
}

export interface InvestmentPerformance {
  series: InvestmentEquityPoint[]
  stats: InvestmentPerformanceStats
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Cost basis moving by more than this fraction counts as a real flow. */
const FLOW_EPSILON_PCT = 0.01

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Map a live investments read into the row shape `investment_snapshots`
 * stores. Refuses anything without a known total: writing a null as 0 would
 * read back as a crash to zero and poison every stat derived from the curve.
 */
export function buildInvestmentSnapshotRow(p: InvestmentPortfolio): InvestmentSnapshotRow {
  if (p.status === 'unavailable') {
    throw new Error(
      'investments layer is unavailable — refusing to record a snapshot rather than store a phantom zero',
    )
  }
  if (p.total_market_value_reporting == null || p.total_cost_basis_reporting == null) {
    throw new Error(
      'investments total is unknown (FX unresolved) — refusing to record a partial snapshot',
    )
  }
  return {
    reportingCurrency: p.reporting_currency,
    marketValue: round2(p.total_market_value_reporting),
    costBasis: round2(p.total_cost_basis_reporting),
    unrealizedPl: round2(p.total_unrealized_pl_reporting ?? 0),
    dayChange: p.total_day_change_reporting == null ? null : round2(p.total_day_change_reporting),
    dayChangePct: p.total_day_change_pct,
    byCurrency: p.by_currency,
    positions: p.positions,
    accounts: p.accounts,
  }
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/**
 * Bound a read that has no client-side timeout of its own. The api client is
 * created without one, so when moomoo OpenD is down the underlying HTTP call
 * hangs on OpenD's own reconnect loop — which would stall the unattended daily
 * capture. A missed snapshot is fine; a wedged cron is not.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>
}

/** How long the unattended capture waits on the live investments read. */
const CAPTURE_READ_TIMEOUT_MS = 30_000

export interface InvestmentCaptureResult {
  id: string | null
  capturedAt: string | null
  source: SnapshotSource
  skipped: boolean
  row: InvestmentSnapshotRow | null
}

/**
 * Persist one `investment_snapshots` row. source='auto' is idempotent per UTC
 * day so a cron loop can fire repeatedly; manual captures always insert.
 */
export async function captureInvestmentSnapshot(source: SnapshotSource): Promise<InvestmentCaptureResult> {
  const db = getDb()
  if (source === 'auto') {
    const existing = await db
      .select({ id: investmentSnapshots.id, capturedAt: investmentSnapshots.capturedAt })
      .from(investmentSnapshots)
      .where(and(
        eq(investmentSnapshots.source, 'auto'),
        gte(investmentSnapshots.capturedAt, startOfUtcDay(new Date())),
      ))
      .limit(1)
    if (existing[0]) {
      return {
        id: existing[0].id,
        capturedAt: existing[0].capturedAt.toISOString(),
        source,
        skipped: true,
        row: null,
      }
    }
  }

  const { getInvestmentPortfolio } = await import('./investment-portfolio')
  const row = buildInvestmentSnapshotRow(
    await withDeadline(getInvestmentPortfolio(), CAPTURE_READ_TIMEOUT_MS, 'investments read'),
  )

  const inserted = await db
    .insert(investmentSnapshots)
    .values({
      source,
      reportingCurrency: row.reportingCurrency,
      marketValue: row.marketValue.toFixed(2),
      costBasis: row.costBasis.toFixed(2),
      unrealizedPl: row.unrealizedPl.toFixed(2),
      dayChange: row.dayChange == null ? null : row.dayChange.toFixed(2),
      dayChangePct: row.dayChangePct == null ? null : row.dayChangePct.toFixed(4),
      byCurrency: row.byCurrency,
      positions: row.positions,
      accounts: row.accounts,
    })
    .returning({ id: investmentSnapshots.id, capturedAt: investmentSnapshots.capturedAt })
  const inserted0 = inserted[0]
  return {
    id: inserted0?.id ?? null,
    capturedAt: inserted0?.capturedAt ? inserted0.capturedAt.toISOString() : null,
    source,
    skipped: false,
    row,
  }
}

function periodReturn(series: InvestmentEquityPoint[], last: InvestmentEquityPoint, days: number): number | null {
  const base = periodBaseline(series, last.t, days)
  return base && base.marketValue > 0 ? ((last.marketValue / base.marketValue) - 1) * 100 : null
}

function pctChange(from: number, to: number): number | null {
  return from > 0 ? ((to / from) - 1) * 100 : null
}

/** Equity-curve stats over chronologically ordered investment snapshots. */
export function computeInvestmentPerformance(points: InvestmentEquityPoint[]): InvestmentPerformance {
  const series = points
    .filter(p => Number.isFinite(p.marketValue))
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
        valueChangePct: null,
        costBasisChangePct: null,
        flowsDetected: false,
        unrealizedPlPctFirst: null,
        unrealizedPlPctLast: null,
        maxDrawdownPct: null,
        periodReturns: { d1: null, d7: null, d30: null },
      },
    }
  }

  let peak = Number.NEGATIVE_INFINITY
  let maxDrawdownPct = 0
  for (const p of series) {
    peak = Math.max(peak, p.marketValue)
    if (peak > 0) {
      maxDrawdownPct = Math.min(maxDrawdownPct, ((p.marketValue / peak) - 1) * 100)
    }
  }

  const costBasisChangePct = pctChange(first.costBasis, last.costBasis)

  return {
    series,
    stats: {
      count: series.length,
      firstAt: first.t,
      lastAt: last.t,
      currency: last.currency,
      valueChangePct: pctChange(first.marketValue, last.marketValue),
      costBasisChangePct,
      flowsDetected: costBasisChangePct != null && Math.abs(costBasisChangePct) > FLOW_EPSILON_PCT,
      unrealizedPlPctFirst: first.costBasis > 0 ? (first.unrealizedPl / first.costBasis) * 100 : null,
      unrealizedPlPctLast: last.costBasis > 0 ? (last.unrealizedPl / last.costBasis) * 100 : null,
      maxDrawdownPct,
      periodReturns: {
        d1: periodReturn(series, last, 1),
        d7: periodReturn(series, last, 7),
        d30: periodReturn(series, last, 30),
      },
    },
  }
}

/** Load investment snapshots for the last `days` days and derive the curve. */
export async function getInvestmentPerformance(opts: { days?: number } = {}): Promise<InvestmentPerformance> {
  const days = Math.max(1, Math.min(3650, Math.floor(opts.days ?? 365)))
  const db = getDb()
  const rows = await db
    .select({
      capturedAt: investmentSnapshots.capturedAt,
      source: investmentSnapshots.source,
      reportingCurrency: investmentSnapshots.reportingCurrency,
      marketValue: investmentSnapshots.marketValue,
      costBasis: investmentSnapshots.costBasis,
      unrealizedPl: investmentSnapshots.unrealizedPl,
      dayChange: investmentSnapshots.dayChange,
      dayChangePct: investmentSnapshots.dayChangePct,
    })
    .from(investmentSnapshots)
    .where(gte(investmentSnapshots.capturedAt, new Date(Date.now() - days * DAY_MS)))
    .orderBy(desc(investmentSnapshots.capturedAt))
    .limit(2000)
  return computeInvestmentPerformance(rows.map(r => ({
    t: r.capturedAt.toISOString(),
    source: r.source,
    currency: r.reportingCurrency,
    marketValue: Number(r.marketValue),
    costBasis: Number(r.costBasis),
    unrealizedPl: Number(r.unrealizedPl),
    dayChange: r.dayChange == null ? null : Number(r.dayChange),
    dayChangePct: r.dayChangePct == null ? null : Number(r.dayChangePct),
  })))
}
