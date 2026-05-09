import YahooFinance from 'yahoo-finance2'

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

export interface FundamentalsBundle {
  metrics: FinancialMetrics
  history: HistoricalPeriod[]
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

export async function getFinancialMetrics(symbol: string): Promise<FinancialMetrics> {
  const yfSym = toYahooSymbol(symbol)
  try {
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
  } catch (err) {
    console.error('[yahoo] getFinancialMetrics failed', symbol, err)
    return EMPTY_METRICS(symbol)
  }
}

export async function getHistorical(symbol: string, limit = 5): Promise<HistoricalPeriod[]> {
  const yfSym = toYahooSymbol(symbol)
  try {
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

export async function getInsiderTrades(symbol: string, limit = 20): Promise<InsiderTrade[]> {
  const yfSym = toYahooSymbol(symbol)
  try {
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
  } catch (err) {
    console.error('[yahoo] getInsiderTrades failed', symbol, err)
    return []
  }
}

export async function getCompanyNews(symbol: string, limit = 10): Promise<NewsItem[]> {
  const yfSym = toYahooSymbol(symbol)
  try {
    const r = await yahoo.search(yfSym, { newsCount: limit, quotesCount: 0 })
    return (r.news ?? []).slice(0, limit).map((n) => ({
      title: n.title ?? '',
      url: n.link ?? '',
      published_at: n.providerPublishTime
        ? new Date(n.providerPublishTime).toISOString()
        : '',
      sentiment: null,
    }))
  } catch (err) {
    console.error('[yahoo] getCompanyNews failed', symbol, err)
    return []
  }
}

export async function getFundamentalsBundle(symbol: string): Promise<FundamentalsBundle> {
  const [metrics, history] = await Promise.all([
    getFinancialMetrics(symbol),
    getHistorical(symbol, 5),
  ])
  return { metrics, history }
}
