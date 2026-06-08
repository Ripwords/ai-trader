import YahooFinance from 'yahoo-finance2'
import type { SymbolResolution } from '../../types/symbol'

const yahoo = new YahooFinance({ suppressNotices: ['yahooSurvey'] })

export interface FinancialMetrics {
  symbol: string
  market_cap: number | null
  pe_ratio: number | null
  pb_ratio: number | null
  ps_ratio: number | null
  eps: number | null
  dividend_yield: number | null
  return_on_equity: number | null
  return_on_assets: number | null
  profit_margin: number | null
  operating_margin: number | null
  revenue_growth: number | null
  earnings_growth: number | null
  debt_to_equity: number | null
  current_ratio: number | null
  free_cash_flow: number | null
  beta: number | null
  shares_outstanding: number | null
}

export interface HistoricalPeriod {
  period: string
  revenue: number | null
  net_income: number | null
  eps: number | null
  fcf: number | null
  total_debt: number | null
  total_assets: number | null
  shareholders_equity: number | null
}

export interface BalanceSheetSnapshot {
  period: string
  total_assets: number | null
  total_liabilities: number | null
  total_equity: number | null
  total_debt: number | null
}

export interface CashflowSnapshot {
  period: string
  free_cash_flow: number | null
}

export interface IncomeStatementSnapshot {
  period: string
  revenue: number | null
  net_income: number | null
  eps: number | null
}

export interface FundamentalsBundle {
  symbol: string
  metrics: FinancialMetrics
  history: HistoricalPeriod[]
  /** Most-recent-period balance sheet projection. null if unavailable. */
  balance_sheet: BalanceSheetSnapshot | null
  /** Most-recent-period cashflow projection. null if unavailable. */
  cashflow: CashflowSnapshot | null
  /** Most-recent-period income statement projection. null if unavailable. */
  income_statement: IncomeStatementSnapshot | null
}

export interface InsiderTrade {
  date: string
  insider_name: string
  transaction_type: 'buy' | 'sell'
  shares: number
  value: number | null
}

export interface NewsItem {
  title: string
  url: string
  published_at: string
  sentiment: 'positive' | 'negative' | 'neutral' | null
}

export interface DailyBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface EarningsInfo {
  next_earnings_date: string | null
  days_until_earnings: number | null
  last_earnings_date: string | null
  last_eps_actual: number | null
  last_eps_estimate: number | null
  last_eps_surprise_pct: number | null
}

const EMPTY_EARNINGS: EarningsInfo = {
  next_earnings_date: null,
  days_until_earnings: null,
  last_earnings_date: null,
  last_eps_actual: null,
  last_eps_estimate: null,
  last_eps_surprise_pct: null,
}

const EMPTY_METRICS = (symbol: string): FinancialMetrics => ({
  symbol,
  market_cap: null, pe_ratio: null, pb_ratio: null, ps_ratio: null,
  eps: null, dividend_yield: null,
  return_on_equity: null, return_on_assets: null,
  profit_margin: null, operating_margin: null,
  revenue_growth: null, earnings_growth: null,
  debt_to_equity: null, current_ratio: null,
  free_cash_flow: null, beta: null, shares_outstanding: null,
})

export function toYahooSymbol(s: string): string {
  // moomoo-style "US.NVDA" / "HK.00700" / "SH.600519" / "SZ.000001" → yahoo
  const m = s.match(/^([A-Z]{2})\.(.+)$/)
  if (!m) return s
  const mkt = m[1]
  const code = m[2] ?? ''
  if (mkt === 'US') return code
  if (mkt === 'HK') return `${code.replace(/^0+/, '').padStart(4, '0')}.HK`
  if (mkt === 'SH') return `${code}.SS`
  if (mkt === 'SZ') return `${code}.SZ`
  return s
}

function f(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== 'object') return null
  return num((obj as Record<string, unknown>)[key])
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'object' && v !== null && 'raw' in v) {
    const r = (v as { raw: unknown }).raw
    return typeof r === 'number' && Number.isFinite(r) ? r : null
  }
  return null
}

const fetchFinancialMetrics = defineCachedFunction(
  async (symbol: string): Promise<FinancialMetrics> => {
    const yfSym = toYahooSymbol(symbol)
    const q = await yahoo.quoteSummary(yfSym, {
      modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData', 'price'],
    })
    const sd = q.summaryDetail
    const ks = q.defaultKeyStatistics
    const fd = q.financialData
    const p = q.price
    return {
      symbol,
      market_cap: num(sd?.marketCap) ?? num(p?.marketCap),
      pe_ratio: num(sd?.trailingPE),
      pb_ratio: num(ks?.priceToBook),
      ps_ratio: num(sd?.priceToSalesTrailing12Months),
      eps: num(ks?.trailingEps),
      dividend_yield: num(sd?.dividendYield),
      return_on_equity: num(fd?.returnOnEquity),
      return_on_assets: num(fd?.returnOnAssets),
      profit_margin: num(fd?.profitMargins),
      operating_margin: num(fd?.operatingMargins),
      revenue_growth: num(fd?.revenueGrowth),
      earnings_growth: num(fd?.earningsGrowth),
      debt_to_equity: num(fd?.debtToEquity),
      current_ratio: num(fd?.currentRatio),
      free_cash_flow: num(fd?.freeCashflow),
      beta: num(sd?.beta) ?? num(ks?.beta),
      shares_outstanding: num(ks?.sharesOutstanding),
    }
  },
  {
    name: 'yahoo',
    group: 'metrics',
    maxAge: 60 * 60 * 6,
    swr: true,
    getKey: (symbol: string) => symbol,
  },
)

export async function getFinancialMetrics(symbol: string): Promise<FinancialMetrics> {
  try {
    return await fetchFinancialMetrics(symbol)
  } catch (err) {
    console.error('[yahoo] getFinancialMetrics failed', symbol, err)
    return EMPTY_METRICS(symbol)
  }
}

const fetchHistorical = defineCachedFunction(
  async (symbol: string, limit: number): Promise<HistoricalPeriod[]> => {
    const yfSym = toYahooSymbol(symbol)
    const q = await yahoo.quoteSummary(yfSym, {
      modules: ['incomeStatementHistory', 'balanceSheetHistory', 'cashflowStatementHistory'],
    })
    const income = q.incomeStatementHistory?.incomeStatementHistory ?? []
    const balance = q.balanceSheetHistory?.balanceSheetStatements ?? []
    const cashflow = q.cashflowStatementHistory?.cashflowStatements ?? []
    const out: HistoricalPeriod[] = []
    const len = Math.min(income.length, limit)
    for (let i = 0; i < len; i++) {
      const inc = income[i]
      const bal = balance[i]
      const cf = cashflow[i]
      if (!inc) continue
      const endDate = (inc as { endDate?: Date | string | null }).endDate
      const period = endDate ? new Date(endDate).getFullYear().toString() : `period_${i}`
      const opCf = f(cf, 'totalCashFromOperatingActivities')
      const capex = f(cf, 'capitalExpenditures')
      const fcf = opCf !== null ? opCf + (capex ?? 0) : null
      const shortDebt = f(bal, 'shortLongTermDebt')
      const longDebt = f(bal, 'longTermDebt')
      const totalDebt = shortDebt !== null || longDebt !== null
        ? (shortDebt ?? 0) + (longDebt ?? 0)
        : null
      out.push({
        period,
        revenue: f(inc, 'totalRevenue'),
        net_income: f(inc, 'netIncome'),
        eps: null,
        fcf,
        total_debt: totalDebt,
        total_assets: f(bal, 'totalAssets'),
        shareholders_equity: f(bal, 'totalStockholderEquity'),
      })
    }
    return out
  },
  {
    name: 'yahoo',
    group: 'historical',
    maxAge: 60 * 60 * 24,
    swr: true,
    getKey: (symbol: string, limit: number) => `${symbol}:${limit}`,
  },
)

export async function getHistorical(symbol: string, limit = 5): Promise<HistoricalPeriod[]> {
  try {
    return await fetchHistorical(symbol, limit)
  } catch (err) {
    console.error('[yahoo] getHistorical failed', symbol, err)
    return []
  }
}

/**
 * Classify Yahoo's free-text `transactionText`. Only real money-flow events
 * (open-market sales/purchases) are returned to sentiment scoring; grants,
 * RSU vests, gifts, exercises and other mechanical filings are noise that
 * skews insider direction and are filtered out here.
 */
function classifyInsiderText(text: string): 'buy' | 'sell' | null {
  const t = text.toLowerCase()
  // Mechanical filings — not signal. Check first since "Stock Gift" doesn't
  // contain "sale" but neither is it a real buy.
  if (t.includes('grant') || t.includes('award')) return null
  if (t.includes('gift')) return null
  if (t.includes('exercise') || t.includes('conversion')) return null
  if (t.includes('vest')) return null
  if (t.includes('statement of ownership')) return null
  // Real signal.
  if (t.includes('sale') || t.includes('sell')) return 'sell'
  if (t.includes('purchase') || t.includes('buy')) return 'buy'
  return null
}

const fetchInsiderTrades = defineCachedFunction(
  async (symbol: string, limit: number): Promise<InsiderTrade[]> => {
    const yfSym = toYahooSymbol(symbol)
    const q = await yahoo.quoteSummary(yfSym, { modules: ['insiderTransactions'] })
    const txns = q.insiderTransactions?.transactions ?? []
    const out: InsiderTrade[] = []
    for (const t of txns) {
      if (out.length >= limit) break
      const direction = classifyInsiderText(String(t.transactionText ?? ''))
      if (!direction) continue
      out.push({
        date: t.startDate ? new Date(t.startDate).toISOString().slice(0, 10) : '',
        insider_name: t.filerName ?? '',
        transaction_type: direction,
        shares: num(t.shares) ?? 0,
        value: num(t.value),
      })
    }
    return out
  },
  {
    name: 'yahoo',
    group: 'insider',
    maxAge: 60 * 60 * 6,
    swr: true,
    getKey: (symbol: string, limit: number) => `${symbol}:${limit}`,
  },
)

export async function getInsiderTrades(symbol: string, limit = 20): Promise<InsiderTrade[]> {
  try {
    return await fetchInsiderTrades(symbol, limit)
  } catch (err) {
    console.error('[yahoo] getInsiderTrades failed', symbol, err)
    return []
  }
}

const fetchCompanyNews = defineCachedFunction(
  async (symbol: string, limit: number): Promise<NewsItem[]> => {
    const yfSym = toYahooSymbol(symbol)
    const r = await yahoo.search(yfSym, { newsCount: limit, quotesCount: 0 })
    return (r.news ?? []).slice(0, limit).map((n) => ({
      title: n.title ?? '',
      url: n.link ?? '',
      published_at: n.providerPublishTime
        ? new Date(n.providerPublishTime).toISOString()
        : '',
      sentiment: null,
    }))
  },
  {
    name: 'yahoo',
    group: 'news',
    maxAge: 60 * 15,
    swr: true,
    getKey: (symbol: string, limit: number) => `${symbol}:${limit}`,
  },
)

export async function getCompanyNews(symbol: string, limit = 10): Promise<NewsItem[]> {
  try {
    return await fetchCompanyNews(symbol, limit)
  } catch (err) {
    console.error('[yahoo] getCompanyNews failed', symbol, err)
    return []
  }
}

const fetchDailyBars = defineCachedFunction(
  async (symbol: string, limit: number): Promise<DailyBar[]> => {
    const yfSym = toYahooSymbol(symbol)
    const days = Math.max(limit * 2, limit + 30, 90)
    const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const chart = await yahoo.chart(yfSym, { period1, interval: '1d' })
    return (chart.quotes ?? [])
      .filter(q =>
        q.open !== null &&
        q.high !== null &&
        q.low !== null &&
        q.close !== null &&
        q.volume !== null,
      )
      .slice(-limit)
      .map(q => ({
        time: q.date.toISOString().slice(0, 10),
        open: q.open as number,
        high: q.high as number,
        low: q.low as number,
        close: q.close as number,
        volume: q.volume as number,
      }))
  },
  {
    name: 'yahoo',
    group: 'daily-bars',
    maxAge: 60 * 60 * 6,
    swr: true,
    getKey: (symbol: string, limit: number) => `${symbol}:${limit}`,
  },
)

export async function getDailyBars(symbol: string, limit = 252): Promise<DailyBar[]> {
  try {
    return await fetchDailyBars(symbol, limit)
  } catch (err) {
    console.error('[yahoo] getDailyBars failed', symbol, err)
    return []
  }
}

export async function getFundamentalsBundle(symbol: string): Promise<FundamentalsBundle> {
  const [metrics, history] = await Promise.all([
    getFinancialMetrics(symbol),
    getHistorical(symbol, 5),
  ])
  const latest = history[0] ?? null
  // Derive snake_case per-statement projections from the most recent period.
  // Yahoo's quoteSummary already gave us the parts we care about — total
  // assets, debt, equity, FCF, revenue, net income — flattened into
  // HistoricalPeriod. The /internal/* routes consume these directly.
  const balance_sheet: BalanceSheetSnapshot | null = latest
    ? {
        period: latest.period,
        total_assets: latest.total_assets,
        total_liabilities: latest.total_assets !== null && latest.shareholders_equity !== null
          ? latest.total_assets - latest.shareholders_equity
          : null,
        total_equity: latest.shareholders_equity,
        total_debt: latest.total_debt,
      }
    : null
  const cashflow: CashflowSnapshot | null = latest
    ? { period: latest.period, free_cash_flow: latest.fcf }
    : null
  const income_statement: IncomeStatementSnapshot | null = latest
    ? {
        period: latest.period,
        revenue: latest.revenue,
        net_income: latest.net_income,
        eps: latest.eps,
      }
    : null
  return { symbol, metrics, history, balance_sheet, cashflow, income_statement }
}

interface EarningsRaw {
  next_earnings_date: string | null
  last_earnings_date: string | null
  last_eps_actual: number | null
  last_eps_estimate: number | null
  last_eps_surprise_pct: number | null
}

const fetchEarningsRaw = defineCachedFunction(
  async (symbol: string): Promise<EarningsRaw> => {
    const yfSym = toYahooSymbol(symbol)
    const q = await yahoo.quoteSummary(yfSym, {
      modules: ['calendarEvents', 'earningsHistory'],
    })

    const earnings = q.calendarEvents?.earnings
    const dates = earnings?.earningsDate ?? []
    const nextDate = dates[0] ? new Date(dates[0]) : null
    const next_earnings_date = nextDate && !Number.isNaN(nextDate.getTime())
      ? nextDate.toISOString().slice(0, 10)
      : null

    const history = q.earningsHistory?.history ?? []
    const last = history.length > 0 ? history[history.length - 1] : null
    const lastQuarter = last?.quarter ? new Date(last.quarter) : null
    const last_earnings_date = lastQuarter && !Number.isNaN(lastQuarter.getTime())
      ? lastQuarter.toISOString().slice(0, 10)
      : null

    return {
      next_earnings_date,
      last_earnings_date,
      last_eps_actual: num(last?.epsActual),
      last_eps_estimate: num(last?.epsEstimate),
      last_eps_surprise_pct: num(last?.surprisePercent),
    }
  },
  {
    name: 'yahoo',
    group: 'earnings',
    maxAge: 60 * 60 * 6,
    swr: true,
    getKey: (symbol: string) => symbol,
  },
)

export interface QuarterlyPeriod {
  period: string         // "FY25 Q3" or fallback "2025-10-31"
  end_date: string       // ISO date string
  revenue: number | null
  net_income: number | null
  eps: number | null
  operating_income: number | null
}

const fetchQuarterlyHistorical = defineCachedFunction(
  async (symbol: string, limit: number): Promise<QuarterlyPeriod[]> => {
    const yfSym = toYahooSymbol(symbol)
    const q = await yahoo.quoteSummary(yfSym, {
      modules: ['incomeStatementHistoryQuarterly', 'earningsHistory'],
    })
    const income = q.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? []
    const earningsRows = q.earningsHistory?.history ?? []
    const out: QuarterlyPeriod[] = []
    const len = Math.min(income.length, limit)
    for (let i = 0; i < len; i++) {
      const inc = income[i]
      if (!inc) continue
      const endDate = (inc as { endDate?: Date | string | null }).endDate
      const isoDate = endDate ? new Date(endDate).toISOString().slice(0, 10) : ''
      // Match an earningsHistory row by date for actual EPS.
      const matched = earningsRows.find((r) => {
        const rd = (r as { quarter?: Date | string | null }).quarter
        if (!rd || !endDate) return false
        return new Date(rd).toISOString().slice(0, 10) === isoDate
      })
      const eps = matched ? num((matched as { epsActual?: unknown }).epsActual) : null
      const dt = endDate ? new Date(endDate) : null
      const period = dt
        ? `${dt.getUTCFullYear()} Q${Math.floor(dt.getUTCMonth() / 3) + 1}`
        : `period_${i}`
      out.push({
        period,
        end_date: isoDate,
        revenue: f(inc, 'totalRevenue'),
        net_income: f(inc, 'netIncome'),
        operating_income: f(inc, 'operatingIncome'),
        eps,
      })
    }
    return out
  },
  {
    name: 'yahoo',
    group: 'historical-q',
    maxAge: 60 * 60 * 12,
    swr: true,
    getKey: (symbol: string, limit: number) => `${symbol}:${limit}`,
  },
)

export async function getQuarterlyHistory(symbol: string, limit = 8): Promise<QuarterlyPeriod[]> {
  try {
    return await fetchQuarterlyHistorical(symbol, limit)
  } catch (err) {
    console.error('[yahoo] getQuarterlyHistory failed', symbol, err)
    return []
  }
}

export async function getEarningsInfo(symbol: string): Promise<EarningsInfo> {
  let raw: EarningsRaw
  try {
    raw = await fetchEarningsRaw(symbol)
  } catch (err) {
    console.error('[yahoo] getEarningsInfo failed', symbol, err)
    return { ...EMPTY_EARNINGS }
  }
  // days_until_earnings is computed at read-time so the cached entry doesn't
  // serve a stale countdown when the calendar date itself hasn't changed.
  let days_until_earnings: number | null = null
  if (raw.next_earnings_date) {
    const t = new Date(raw.next_earnings_date).getTime()
    if (!Number.isNaN(t)) days_until_earnings = Math.round((t - Date.now()) / 86_400_000)
  }
  return { ...raw, days_until_earnings }
}

export interface SymbolSearchResult {
  /** moomoo-style symbol if the listing is tradable on moomoo, otherwise null. */
  moomoo: string | null
  /** Yahoo-style symbol (always present). */
  yahoo: string
  name: string
  exchange: string
  type: string
}

/** Inverse of toYahooSymbol — convert a Yahoo ticker back to moomoo style.
 *  Returns null if the listing isn't on a moomoo-supported market. */
function fromYahooSymbol(yfSym: string, exchange: string): string | null {
  if (yfSym.endsWith('.HK')) {
    const code = yfSym.slice(0, -3).padStart(5, '0')
    return `HK.${code}`
  }
  if (yfSym.endsWith('.SS')) return `SH.${yfSym.slice(0, -3)}`
  if (yfSym.endsWith('.SZ')) return `SZ.${yfSym.slice(0, -3)}`
  // US listings have no suffix. Filter to known US exchanges so we don't
  // misclassify .L / .DE / .MX / .AS / .TO / etc as US.
  const usExchanges = ['NASDAQ', 'NYSE', 'NYSEArca', 'AMEX', 'BATS', 'BATS Trading', 'NMS', 'NYQ', 'ASE', 'PCX']
  if (!yfSym.includes('.') && usExchanges.some(x => exchange.includes(x))) {
    return `US.${yfSym}`
  }
  return null
}

const fetchSymbolSearch = defineCachedFunction(
  async (query: string, limit: number): Promise<SymbolSearchResult[]> => {
    const r = await yahoo.search(
      query,
      { quotesCount: limit, newsCount: 0 },
      { validateResult: false },
    ) as { quotes?: unknown[] }
    const out: SymbolSearchResult[] = []
    for (const item of r.quotes ?? []) {
      const q = item as { symbol?: string; shortname?: string; longname?: string; exchDisp?: string; typeDisp?: string }
      if (!q.symbol) continue
      const exchange = String(q.exchDisp ?? '')
      out.push({
        moomoo: fromYahooSymbol(q.symbol, exchange),
        yahoo: q.symbol,
        name: q.shortname ?? q.longname ?? '',
        exchange,
        type: q.typeDisp ?? '',
      })
    }
    return out
  },
  {
    name: 'yahoo',
    group: 'search',
    maxAge: 60 * 60,
    swr: true,
    getKey: (query: string, limit: number) => `${query.toLowerCase()}:${limit}`,
  },
)

export async function searchSymbols(query: string, limit = 8): Promise<SymbolSearchResult[]> {
  const q = query.trim()
  if (q.length < 1) return []
  try {
    return await fetchSymbolSearch(q, limit)
  } catch (err) {
    console.error('[yahoo] searchSymbols failed', query, err)
    return []
  }
}

export type { SymbolResolution }

/**
 * Resolve a symbol-shaped input (`MU`, `US.MU`, `us.mu`, `HK.00700`) to a
 * single canonical listing via Yahoo. The single source of truth every
 * service resolves through — see
 * docs/superpowers/specs/2026-05-18-canonical-ticker-resolution-design.md.
 *
 * Fails closed: only an exact-ticker Yahoo equity is `resolved`; anything else
 * is `ambiguous`/`not_found` so callers can force a pick rather than silently
 * guess (the `US.MU` → "Munich Re" bug). `moomoo` is populated only when the
 * exact Yahoo listing maps to a moomoo-supported market.
 */
export async function resolveSymbol(input: string): Promise<SymbolResolution> {
  const raw = input.trim()
  if (!raw) return { status: 'not_found' }
  // Search on the Yahoo-form ticker so "US.MU" finds Micron, not the literal
  // string "US.MU".
  const expectedYahoo = toYahooSymbol(raw.toUpperCase())
  let results: SymbolSearchResult[]
  try {
    results = await fetchSymbolSearch(expectedYahoo, 10)
  } catch (err) {
    console.error('[yahoo] resolveSymbol failed', input, err)
    return { status: 'error' }
  }
  if (results.length === 0) return { status: 'not_found' }
  const exact = results.find(
    r =>
      r.yahoo.toUpperCase() === expectedYahoo.toUpperCase() &&
      r.type.toUpperCase() === 'EQUITY',
  )
  if (exact) {
    return {
      status: 'resolved',
      symbol: exact.moomoo ?? exact.yahoo,
      moomoo: exact.moomoo,
      yahoo: exact.yahoo,
      name: exact.name,
      exchange: exact.exchange,
      quoteType: exact.type,
    }
  }
  return { status: 'ambiguous', candidates: results.slice(0, 8) }
}

const fetchFxRate = defineCachedFunction(
  async (from: string, to: string): Promise<number> => {
    const pair = `${from}${to}=X`
    const q = await yahoo.quote(pair)
    const rate = num((q as { regularMarketPrice?: unknown }).regularMarketPrice)
    if (rate == null || rate <= 0) {
      // Throw so the empty/invalid result doesn't get cached for an hour.
      throw new Error(`fx rate unavailable for ${pair}`)
    }
    return rate
  },
  {
    name: 'yahoo',
    group: 'fx',
    maxAge: 60 * 60,
    swr: true,
    getKey: (from: string, to: string) => `${from}_${to}`,
  },
)

export async function getFxRate(from: string, to: string): Promise<number | null> {
  const fromU = from.toUpperCase().trim()
  const toU = to.toUpperCase().trim()
  if (fromU === toU) return 1
  try {
    return await fetchFxRate(fromU, toU)
  } catch (err) {
    console.error('[yahoo] getFxRate failed', from, to, err)
    return null
  }
}
