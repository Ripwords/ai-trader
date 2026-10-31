/**
 * Consensus vs actual for recent quarters, from Yahoo Finance quoteSummary
 * (earningsHistory, earnings, earningsTrend, calendarEvents).
 *
 * Yahoo keeps the EPS estimate for the last four reported quarters but not
 * the revenue estimate: `revenueEstimate` exists only for upcoming periods.
 * Past-quarter revenue consensus therefore stays null rather than guessed.
 */
import { toYahooSymbol, yahooClient } from './yahoo'

export interface SurpriseQuarter {
  fiscal_quarter: string
  period_end: string | null
  reported_date: string | null
  days_since_report: number | null
  eps_estimate: number | null
  eps_actual: number | null
  eps_surprise_pct: number | null
  revenue_actual: number | null
  /** Not published by Yahoo for past quarters; always null. */
  revenue_estimate: null
}

export interface ConsensusPeriod {
  period: string
  period_end: string | null
  eps_avg: number | null
  eps_low: number | null
  eps_high: number | null
  year_ago_eps: number | null
  analysts: number | null
  revenue_avg: number | null
  revenue_low: number | null
  revenue_high: number | null
  year_ago_revenue: number | null
  revenue_growth: number | null
  eps_trend: { current: number | null; d7: number | null; d30: number | null; d60: number | null; d90: number | null } | null
  revisions: { up_7d: number | null; up_30d: number | null; down_7d: number | null; down_30d: number | null } | null
}

export interface EarningsSurprise {
  symbol: string
  source: string
  quarters: SurpriseQuarter[]
  latest: SurpriseQuarter | null
  next_quarter: ConsensusPeriod | null
  current_year: ConsensusPeriod | null
  next_earnings_date: string | null
  notes: string[]
}

export const SURPRISE_SOURCE = 'Yahoo Finance consensus (quoteSummary earningsHistory, earnings, earningsTrend, calendarEvents)'

type Obj = Record<string, unknown>

function obj(v: unknown): Obj | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function n(o: Obj | null, key: string): number | null {
  const v = o?.[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const raw = obj(v)?.raw
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}
function isoDate(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString().slice(0, 10)
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
  }
  return null
}
const round2 = (x: number) => Math.round(x * 100) / 100

function fiscalLabel(periodEnd: string): string {
  const d = new Date(`${periodEnd}T00:00:00Z`)
  return `${Math.floor(d.getUTCMonth() / 3) + 1}Q${d.getUTCFullYear()}`
}

function consensus(t: Obj): ConsensusPeriod {
  const e = obj(t.earningsEstimate)
  const r = obj(t.revenueEstimate)
  const tr = obj(t.epsTrend)
  const rv = obj(t.epsRevisions)
  return {
    period: typeof t.period === 'string' ? t.period : '',
    period_end: isoDate(t.endDate),
    eps_avg: n(e, 'avg'),
    eps_low: n(e, 'low'),
    eps_high: n(e, 'high'),
    year_ago_eps: n(e, 'yearAgoEps'),
    analysts: n(e, 'numberOfAnalysts'),
    revenue_avg: n(r, 'avg'),
    revenue_low: n(r, 'low'),
    revenue_high: n(r, 'high'),
    year_ago_revenue: n(r, 'yearAgoRevenue'),
    revenue_growth: n(r, 'growth'),
    eps_trend: tr ? { current: n(tr, 'current'), d7: n(tr, '7daysAgo'), d30: n(tr, '30daysAgo'), d60: n(tr, '60daysAgo'), d90: n(tr, '90daysAgo') } : null,
    revisions: rv ? { up_7d: n(rv, 'upLast7days'), up_30d: n(rv, 'upLast30days'), down_7d: n(rv, 'downLast7Days') ?? n(rv, 'downLast7days'), down_30d: n(rv, 'downLast30days') } : null,
  }
}

/** Pure: raw quoteSummary result → surprise table. `now` is ms since epoch. */
export function shapeEarningsSurprise(symbol: string, raw: unknown, now: number): EarningsSurprise {
  const root = obj(raw) ?? {}
  const earnings = obj(root.earnings)
  const chart = arr(obj(earnings?.earningsChart)?.quarterly).map(obj).filter((x): x is Obj => x !== null)
  const fin = arr(obj(earnings?.financialsChart)?.quarterly).map(obj).filter((x): x is Obj => x !== null)
  const today = new Date(now).toISOString().slice(0, 10)

  const quarters: SurpriseQuarter[] = []
  for (const h of arr(obj(root.earningsHistory)?.history).map(obj)) {
    if (!h) continue
    const periodEnd = isoDate(h.quarter)
    const c = chart.find(x => periodEnd !== null && isoDate(x.periodEndDate) === periodEnd)
    const label = typeof c?.date === 'string' ? c.date : periodEnd ? fiscalLabel(periodEnd) : ''
    const revenue = fin.find(x => x.date === label)
    const est = n(h, 'epsEstimate')
    const act = n(h, 'epsActual')
    const pct = n(h, 'surprisePercent')
    const surprise = pct !== null ? round2(pct * 100) : est !== null && act !== null && est !== 0 ? round2(((act - est) / Math.abs(est)) * 100) : null
    const reported = c ? isoDate(c.reportedDate) : null
    quarters.push({
      fiscal_quarter: label,
      period_end: periodEnd,
      reported_date: reported,
      days_since_report: reported ? Math.round((Date.parse(today) - Date.parse(reported)) / 86_400_000) : null,
      eps_estimate: est,
      eps_actual: act,
      eps_surprise_pct: surprise,
      revenue_actual: revenue ? n(revenue, 'revenue') : null,
      revenue_estimate: null,
    })
  }
  quarters.sort((a, b) => (a.period_end ?? '').localeCompare(b.period_end ?? ''))

  const trends = arr(obj(root.earningsTrend)?.trend).map(obj).filter((x): x is Obj => x !== null)
  const q0 = trends.find(t => t.period === '0q')
  const y0 = trends.find(t => t.period === '0y')
  const cal = obj(obj(root.calendarEvents)?.earnings)
  const dates = arr(cal?.earningsDate).map(isoDate).filter((d): d is string => d !== null)
  const upcoming = dates.find(d => d >= today) ?? null

  return {
    symbol,
    source: SURPRISE_SOURCE,
    quarters,
    latest: quarters.at(-1) ?? null,
    next_quarter: q0 ? consensus(q0) : null,
    current_year: y0 ? consensus(y0) : null,
    next_earnings_date: upcoming,
    notes: [
      'Yahoo does not keep the pre-report revenue consensus for past quarters, so revenue beat/miss cannot be computed here; read the release for the company\'s own framing.',
      'EPS surprise is against GAAP EPS. A very large beat or miss usually comes from non-operating items (investment gains or losses, tax), not the business; check the release before treating it as operating strength or weakness.',
    ],
  }
}

async function fetchEarningsSurprise(symbol: string): Promise<EarningsSurprise> {
  const raw = await yahooClient.quoteSummary(toYahooSymbol(symbol), {
    modules: ['earningsHistory', 'earnings', 'earningsTrend', 'calendarEvents'],
  })
  return shapeEarningsSurprise(symbol, raw, Date.now())
}

const cachedSurprise = defineCachedFunction(fetchEarningsSurprise, {
  name: 'yahoo',
  group: 'earnings-surprise',
  maxAge: 6 * 60 * 60,
  getKey: (symbol: string) => symbol,
}) as typeof fetchEarningsSurprise

/** `days_since_report` is recomputed at read time so a cached entry doesn't age. */
export async function getEarningsSurprise(symbol: string): Promise<EarningsSurprise> {
  const s = await cachedSurprise(symbol)
  const today = Date.parse(new Date().toISOString().slice(0, 10))
  const fresh = s.quarters.map(q => ({
    ...q,
    days_since_report: q.reported_date ? Math.round((today - Date.parse(q.reported_date)) / 86_400_000) : null,
  }))
  return { ...s, quarters: fresh, latest: fresh.at(-1) ?? null }
}
