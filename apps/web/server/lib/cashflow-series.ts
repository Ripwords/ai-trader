/**
 * Operating cash flow, capex and FCF by period, each row labelled with the
 * period it covers so "FCF" figures from different sources stop colliding.
 *
 * SEC XBRL company facts are the primary source for US filers: they are
 * current the day the 10-Q lands. Yahoo's quoteSummary statement modules have
 * been near-empty since late 2024, and its fundamentalsTimeSeries quarterly
 * cash flow lags by a quarter or two, so Yahoo is only the fallback (and the
 * only source for non-US listings).
 */
import { getSecCashflowSeries } from './sec-edgar'
import { toYahooSymbol, yahooClient } from './yahoo'

export interface LabelledCashflowRow {
  period_end: string
  label: string
  operating_cash_flow: number
  /** Positive: cash spent on property and equipment. */
  capex: number
  /** operating_cash_flow − capex */
  fcf: number
}

export interface CashflowSeries {
  symbol: string
  source: string
  definition: string
  quarterly: LabelledCashflowRow[]
  ttm: LabelledCashflowRow | null
  annual: LabelledCashflowRow[]
  notes: string[]
  source_urls: string[]
}

export interface TtmCashflow {
  period_end: string
  operating_cash_flow: number
  capex: number
  fcf: number
  source: string
}

const DEFINITION = 'FCF = operating cash flow − capital expenditures (purchases of property and equipment)'

interface Row { period_end: string; operating_cash_flow: number; capex: number; fcf: number }

const quarterLabel = (r: Row): LabelledCashflowRow => ({ ...r, label: `quarter ended ${r.period_end}` })
const ttmLabel = (r: Row): LabelledCashflowRow => ({ ...r, label: `TTM to ${r.period_end}` })
const yearLabel = (r: Row): LabelledCashflowRow => ({ ...r, label: `fiscal year ended ${r.period_end}` })

function isoDate(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString().slice(0, 10)
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10)
  }
  return null
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Rows from fundamentalsTimeSeries; capex there is negative. */
function yahooRows(raw: unknown): Row[] {
  if (!Array.isArray(raw)) return []
  const rows: Row[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const end = isoDate(rec.date)
    const ocf = finite(rec.operatingCashFlow)
    const capex = finite(rec.capitalExpenditure)
    if (!end || ocf === null || capex === null) continue
    rows.push({ period_end: end, operating_cash_flow: ocf, capex: Math.abs(capex), fcf: ocf - Math.abs(capex) })
  }
  return rows.sort((a, b) => a.period_end.localeCompare(b.period_end))
}

async function yahooSeries(symbol: string): Promise<CashflowSeries | null> {
  const sym = toYahooSymbol(symbol)
  const period1 = `${new Date().getUTCFullYear() - 3}-01-01`
  const pull = (type: 'quarterly' | 'annual' | 'trailing') =>
    yahooClient.fundamentalsTimeSeries(sym, { period1, type, module: 'cash-flow' }, { validateResult: false })
      .then(yahooRows)
      .catch((): Row[] => [])
  const [quarterly, annual, trailing] = await Promise.all([pull('quarterly'), pull('annual'), pull('trailing')])
  if (!quarterly.length && !annual.length && !trailing.length) return null
  const ttm = trailing.at(-1) ?? null
  const lastQ = quarterly.at(-1)
  const notes: string[] = []
  if (lastQ && ttm && lastQ.period_end < ttm.period_end) {
    notes.push(`Yahoo's quarterly series lags: latest quarter is ${lastQ.period_end} while the TTM runs to ${ttm.period_end}.`)
  }
  return {
    symbol,
    source: 'Yahoo Finance fundamentalsTimeSeries (cash-flow)',
    definition: DEFINITION,
    quarterly: quarterly.slice(-8).map(quarterLabel),
    ttm: ttm ? ttmLabel(ttm) : null,
    annual: annual.slice(-4).map(yearLabel),
    notes,
    source_urls: [`https://finance.yahoo.com/quote/${encodeURIComponent(sym)}/cash-flow`],
  }
}

async function buildSeries(symbol: string): Promise<CashflowSeries | null> {
  const sec = await getSecCashflowSeries(symbol).catch((err: unknown) => {
    console.error('[cashflow-series] SEC XBRL failed, falling back to Yahoo', symbol, err)
    return null
  })
  if (sec && sec.quarterly.length) {
    return {
      symbol,
      source: 'SEC EDGAR XBRL company facts (10-Q/10-K)',
      definition: DEFINITION,
      quarterly: sec.quarterly.map(quarterLabel),
      ttm: sec.ttm ? ttmLabel(sec.ttm) : null,
      annual: sec.annual.map(yearLabel),
      notes: [`Capex is the us-gaap ${sec.capex_concept} line. Quarters reported only year-to-date are derived by differencing (Q4 = fiscal year − nine months).`],
      source_urls: sec.source_urls,
    }
  }
  return yahooSeries(symbol)
}

export const getCashflowSeries = defineCachedFunction(buildSeries, {
  name: 'cashflow-series',
  maxAge: 6 * 60 * 60,
  getKey: (symbol: string) => symbol.trim().toUpperCase(),
  validate: entry => entry.value != null,
}) as typeof buildSeries

/** TTM OCF − capex for the valuation cross-check; null on any failure. */
export async function getTtmCashflow(symbol: string): Promise<TtmCashflow | null> {
  try {
    const s = await getCashflowSeries(symbol)
    if (!s?.ttm) return null
    const { period_end, operating_cash_flow, capex, fcf } = s.ttm
    return { period_end, operating_cash_flow, capex, fcf, source: s.source.startsWith('SEC') ? 'SEC EDGAR XBRL' : 'Yahoo Finance' }
  } catch (err) {
    console.error('[cashflow-series] getTtmCashflow failed', symbol, err)
    return null
  }
}
