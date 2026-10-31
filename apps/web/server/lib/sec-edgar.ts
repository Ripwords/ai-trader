/**
 * SEC EDGAR client: the company's own earnings release (8-K Item 2.02,
 * EX-99.1) and quarterly cash flow from XBRL company facts.
 *
 * SEC asks for a descriptive User-Agent with contact details and at most
 * 10 requests/second (https://www.sec.gov/os/accessing-edgar-data). Every
 * request goes through `secJson`/`secText`, which sets the header and spaces calls.
 */
import { filingHtmlToText, prioritiseSections } from './filing-text'

const DEFAULT_USER_AGENT = 'ai-trader contact@jjteoh.com'

export function secUserAgent(): string {
  return process.env.SEC_USER_AGENT?.trim() || DEFAULT_USER_AGENT
}

// ≥110 ms between requests keeps us under SEC's 10 req/s.
let minGapMs = 110
let nextSlot = 0
export function __setThrottleForTests(ms: number): void {
  minGapMs = ms
  nextSlot = 0
}

async function throttle(): Promise<void> {
  const now = Date.now()
  const wait = Math.max(0, nextSlot - now)
  nextSlot = Math.max(now, nextSlot) + minGapMs
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
}

const secHeaders = (accept: string) => ({ 'User-Agent': secUserAgent(), Accept: accept })

async function secJson<T>(url: string): Promise<T> {
  await throttle()
  const { ofetch } = await import('ofetch')
  return ofetch<T>(url, { headers: secHeaders('application/json'), timeout: 20_000, retry: 1 })
}

async function secText(url: string): Promise<string> {
  await throttle()
  const { ofetch } = await import('ofetch')
  return ofetch(url, { responseType: 'text', headers: secHeaders('text/html'), timeout: 20_000, retry: 1 })
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { statusCode?: unknown; status?: unknown }
  return e.statusCode === 404 || e.status === 404
}

// ─── ticker → CIK ───────────────────────────────────────────────────────

export interface CikMatch {
  cik: string
  ticker: string
  title: string
}

interface TickerRow {
  cik_str: number
  ticker: string
  title: string
}

/** "US.AMZN" → "AMZN", "BRK.B" → "BRK-B"; null for a non-US market. */
export function secTicker(symbol: string): string | null {
  const s = symbol.trim().toUpperCase()
  const m = s.match(/^([A-Z]{2})\.(.+)$/)
  if (m && m[1] !== 'US' && !/^[A-Z]$/.test(m[2] ?? '')) return null
  const bare = m && m[1] === 'US' ? (m[2] ?? '') : s
  if (!bare || /\d{4,}/.test(bare)) return null
  return bare.replace(/\./g, '-')
}

let tickerMap: Promise<Map<string, CikMatch>> | null = null

function loadTickerMap(): Promise<Map<string, CikMatch>> {
  if (!tickerMap) {
    tickerMap = secJson<Record<string, TickerRow>>('https://www.sec.gov/files/company_tickers.json')
      .then((raw) => {
        const m = new Map<string, CikMatch>()
        for (const row of Object.values(raw)) {
          if (!m.has(row.ticker)) {
            m.set(row.ticker, { cik: String(row.cik_str).padStart(10, '0'), ticker: row.ticker, title: row.title })
          }
        }
        return m
      })
      .catch((err: unknown) => {
        tickerMap = null
        throw err
      })
  }
  return tickerMap
}

export async function resolveCik(symbol: string): Promise<CikMatch | null> {
  const t = secTicker(symbol)
  if (!t) return null
  const map = await loadTickerMap()
  return map.get(t) ?? null
}

// ─── earnings release ───────────────────────────────────────────────────

interface RecentFilings {
  accessionNumber: string[]
  form: string[]
  filingDate: string[]
  reportDate?: string[]
  items?: string[]
}

export interface Submissions {
  name?: string
  filings: { recent: RecentFilings }
}

export interface EarningsFiling {
  accession: string
  form: string
  filingDate: string
  reportDate: string | null
}

/** Most recent 8-K / 8-K/A whose items include 2.02 (Results of Operations). */
export function findLatestEarnings8K(sub: Submissions): EarningsFiling | null {
  const r = sub.filings.recent
  let best: EarningsFiling | null = null
  for (let i = 0; i < r.accessionNumber.length; i++) {
    const form = r.form[i] ?? ''
    if (form !== '8-K' && form !== '8-K/A') continue
    const items = (r.items?.[i] ?? '').split(',').map(s => s.trim())
    if (!items.includes('2.02')) continue
    const filingDate = r.filingDate[i] ?? ''
    if (!best || filingDate > best.filingDate) {
      best = { accession: r.accessionNumber[i] ?? '', form, filingDate, reportDate: r.reportDate?.[i] || null }
    }
  }
  return best
}

/** Absolute URL of the EX-99.1 document in an EDGAR filing index page. */
export function findExhibit991(indexHtml: string): string | null {
  for (const row of indexHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) ?? []).map(c => c.replace(/<[^>]+>/g, '').trim())
    if (!cells.some(c => /^EX-99(\.0?1)?$/i.test(c))) continue
    const href = row.match(/href="([^"]+)"/i)?.[1]
    if (!href) continue
    // Inline-XBRL viewer links look like /ix?doc=/Archives/...
    const path = href.replace(/^\/ix\?doc=/, '')
    return path.startsWith('http') ? path : `https://www.sec.gov${path}`
  }
  return null
}

export type EarningsRelease =
  | {
      status: 'ok'
      ticker: string
      company: string
      cik: string
      form: string
      filing_date: string
      report_date: string | null
      accession: string
      filing_index_url: string
      exhibit_url: string
      text: string
      chars_total: number
      truncated: boolean
      omitted: string[]
    }
  | { status: 'not_found' | 'no_release'; ticker: string; reason: string; source_url?: string }

const RELEASE_MAX_CHARS = 24_000

async function fetchLatestEarningsRelease(symbol: string): Promise<EarningsRelease> {
  const match = await resolveCik(symbol)
  if (!match) {
    return { status: 'not_found', ticker: symbol, reason: 'not a US SEC filer (no CIK for this ticker in company_tickers.json)' }
  }
  const submissionsUrl = `https://data.sec.gov/submissions/CIK${match.cik}.json`
  const sub = await secJson<Submissions>(submissionsUrl)
  const filing = findLatestEarnings8K(sub)
  if (!filing) {
    return { status: 'no_release', ticker: match.ticker, reason: 'no recent 8-K with Item 2.02 (results of operations)', source_url: submissionsUrl }
  }
  const cikInt = String(Number(match.cik))
  const accNoDash = filing.accession.replace(/-/g, '')
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDash}/${filing.accession}-index.html`
  const indexHtml = await secText(indexUrl)
  const exhibitUrl = findExhibit991(indexHtml)
  if (!exhibitUrl) {
    return { status: 'no_release', ticker: match.ticker, reason: `8-K ${filing.accession} has no EX-99.1 exhibit`, source_url: indexUrl }
  }
  const html = await secText(exhibitUrl)
  const full = filingHtmlToText(html)
  const fitted = prioritiseSections(full, RELEASE_MAX_CHARS)
  return {
    status: 'ok',
    ticker: match.ticker,
    company: sub.name ?? match.title,
    cik: match.cik,
    form: filing.form,
    filing_date: filing.filingDate,
    report_date: filing.reportDate,
    accession: filing.accession,
    filing_index_url: indexUrl,
    exhibit_url: exhibitUrl,
    text: fitted.text,
    chars_total: full.length,
    truncated: fitted.truncated,
    omitted: fitted.omitted,
  }
}

// A release is immutable once filed; 3 h bounds how late a new print shows.
export const getLatestEarningsRelease = defineCachedFunction(fetchLatestEarningsRelease, {
  name: 'sec-earnings-release',
  maxAge: 3 * 60 * 60,
  getKey: (symbol: string) => symbol.trim().toUpperCase(),
  validate: entry => (entry.value as EarningsRelease | undefined)?.status === 'ok',
}) as typeof fetchLatestEarningsRelease

// ─── XBRL cash flow ─────────────────────────────────────────────────────

export interface XbrlFact {
  start?: string
  end: string
  val: number
  form?: string
  filed?: string
}

export interface PeriodValue {
  end: string
  val: number
}

const DAY = 86_400_000
function days(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY)
}

/** One fact per (start, end), keeping the latest filing (restatements win). */
function dedupe(facts: XbrlFact[]): XbrlFact[] {
  const by = new Map<string, XbrlFact>()
  for (const f of facts) {
    if (!f.start) continue
    const k = `${f.start}|${f.end}`
    const prev = by.get(k)
    if (!prev || (f.filed ?? '') > (prev.filed ?? '')) by.set(k, f)
  }
  return [...by.values()]
}

/**
 * Three-month values by period end. A reported 3-month fact is used as is;
 * otherwise the quarter is the difference of two year-to-date facts with the
 * same start whose ends are a quarter apart (Q4 = FY − 9M).
 */
export function quarterlyFromFacts(facts: XbrlFact[]): PeriodValue[] {
  const uniq = dedupe(facts)
  const out = new Map<string, number>()
  for (const f of uniq) {
    const d = days(f.start ?? f.end, f.end)
    if (d >= 80 && d <= 100) out.set(f.end, f.val)
  }
  for (const f of uniq) {
    if (out.has(f.end)) continue
    const d = days(f.start ?? f.end, f.end)
    if (d <= 100) continue
    const prev = uniq.find(p => p.start === f.start && p.end < f.end && days(p.end, f.end) >= 80 && days(p.end, f.end) <= 100)
    if (prev) out.set(f.end, f.val - prev.val)
  }
  return [...out.entries()].map(([end, val]) => ({ end, val })).sort((a, b) => a.end.localeCompare(b.end))
}

/** Fiscal-year values (≈ 1-year duration, from a 10-K). */
export function annualFromFacts(facts: XbrlFact[]): PeriodValue[] {
  return dedupe(facts)
    .filter(f => (f.form ?? '').startsWith('10-K'))
    .filter((f) => {
      const d = days(f.start ?? f.end, f.end)
      return d >= 350 && d <= 380
    })
    .map(f => ({ end: f.end, val: f.val }))
    .sort((a, b) => a.end.localeCompare(b.end))
}

interface CompanyConcept {
  units?: { USD?: XbrlFact[] }
}

const OCF_CONCEPT = 'NetCashProvidedByUsedInOperatingActivities'
// Filers pick different capex tags (Amazon: PaymentsToAcquireProductiveAssets);
// a tag the company stopped using leaves stale facts, so the freshest wins.
const CAPEX_CONCEPTS = ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'] as const

function conceptUrl(cik: string, concept: string): string {
  return `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`
}

async function fetchConcept(cik: string, concept: string): Promise<XbrlFact[] | null> {
  try {
    const c = await secJson<CompanyConcept>(conceptUrl(cik, concept))
    return c.units?.USD ?? null
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

export interface CashflowRow {
  period_end: string
  operating_cash_flow: number
  /** Positive: cash spent on property and equipment. */
  capex: number
  /** operating_cash_flow − capex. */
  fcf: number
}

export interface SecCashflowSeries {
  cik: string
  capex_concept: string
  quarterly: CashflowRow[]
  ttm: CashflowRow | null
  annual: CashflowRow[]
  source_urls: string[]
}

function joinRows(ocf: PeriodValue[], capex: PeriodValue[]): CashflowRow[] {
  const cap = new Map(capex.map(c => [c.end, c.val]))
  const rows: CashflowRow[] = []
  for (const o of ocf) {
    const c = cap.get(o.end)
    if (c === undefined) continue
    rows.push({ period_end: o.end, operating_cash_flow: o.val, capex: Math.abs(c), fcf: o.val - Math.abs(c) })
  }
  return rows
}

/** Sum of the last four quarters, only when they are contiguous. */
function trailingFour(rows: CashflowRow[]): CashflowRow | null {
  const last = rows.slice(-4)
  if (last.length < 4) return null
  for (let i = 1; i < last.length; i++) {
    const gap = days(last[i - 1]!.period_end, last[i]!.period_end)
    if (gap < 80 || gap > 100) return null
  }
  const sum = (k: 'operating_cash_flow' | 'capex') => last.reduce((s, r) => s + r[k], 0)
  const ocf = sum('operating_cash_flow')
  const capex = sum('capex')
  return { period_end: last[3]!.period_end, operating_cash_flow: ocf, capex, fcf: ocf - capex }
}

async function fetchSecCashflowSeries(symbol: string): Promise<SecCashflowSeries | null> {
  const match = await resolveCik(symbol)
  if (!match) return null
  const ocfFacts = await fetchConcept(match.cik, OCF_CONCEPT)
  if (!ocfFacts?.length) return null
  let capexConcept: string | null = null
  let capexFacts: XbrlFact[] = []
  let latest = ''
  for (const concept of CAPEX_CONCEPTS) {
    const facts = await fetchConcept(match.cik, concept)
    const end = facts?.reduce((m, f) => (f.end > m ? f.end : m), '') ?? ''
    if (facts && end > latest) {
      latest = end
      capexConcept = concept
      capexFacts = facts
    }
  }
  if (!capexConcept) return null
  const quarterly = joinRows(quarterlyFromFacts(ocfFacts), quarterlyFromFacts(capexFacts))
  const annual = joinRows(annualFromFacts(ocfFacts), annualFromFacts(capexFacts))
  return {
    cik: match.cik,
    capex_concept: capexConcept,
    quarterly: quarterly.slice(-8),
    ttm: trailingFour(quarterly),
    annual: annual.slice(-4),
    source_urls: [conceptUrl(match.cik, OCF_CONCEPT), conceptUrl(match.cik, capexConcept)],
  }
}

export const getSecCashflowSeries = defineCachedFunction(fetchSecCashflowSeries, {
  name: 'sec-cashflow-series',
  maxAge: 6 * 60 * 60,
  getKey: (symbol: string) => symbol.trim().toUpperCase(),
  validate: entry => entry.value != null,
}) as typeof fetchSecCashflowSeries

const OPERATING_INCOME_CONCEPT = 'OperatingIncomeLoss'

/** Three-month operating income by period end (Q4 = FY − 9M); null for a non-filer. */
async function fetchSecQuarterlyOperatingIncome(symbol: string): Promise<PeriodValue[] | null> {
  const match = await resolveCik(symbol)
  if (!match) return null
  const facts = await fetchConcept(match.cik, OPERATING_INCOME_CONCEPT)
  return facts?.length ? quarterlyFromFacts(facts) : null
}

export const getSecQuarterlyOperatingIncome = defineCachedFunction(fetchSecQuarterlyOperatingIncome, {
  name: 'sec-operating-income',
  maxAge: 6 * 60 * 60,
  getKey: (symbol: string) => symbol.trim().toUpperCase(),
  validate: entry => entry.value != null,
}) as typeof fetchSecQuarterlyOperatingIncome
