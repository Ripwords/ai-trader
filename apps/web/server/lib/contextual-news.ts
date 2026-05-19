import type { NewsResult } from './search'
import { searchWithFallback } from './search'
import { deriveAngles } from './contextual-news-angles'

export interface ContextualNews {
  ticker: NewsResult[]
  macro: NewsResult[]
  contextual: NewsResult[]
  error?: string
}

export interface GetContextualNewsArgs {
  symbol: string
  companyName?: string
  maxResults?: number
}

// Fixed, ticker-agnostic queries → covers rates/monetary policy + broad market.
const MACRO_QUERIES = [
  'Federal Reserve interest rate decision FOMC inflation',
  'US stock market today S&P 500 Nasdaq selloff rally bond yields',
]

const MACRO_CAP = 4
const CONTEXTUAL_CAP = 6

interface SafeSearchResult {
  results: NewsResult[]
  failed: boolean
}

async function safeSearch(query: string, max: number): Promise<SafeSearchResult> {
  try {
    const results = await searchWithFallback('news', query, max)
    return { results, failed: false }
  } catch {
    return { results: [], failed: true }
  }
}

export async function getContextualNews(
  args: GetContextualNewsArgs,
): Promise<ContextualNews> {
  const maxResults = args.maxResults ?? 10
  const tickerQuery = args.companyName
    ? `${args.companyName} ${args.symbol}`
    : args.symbol

  const [tickerRes, macroRes, angleRes] = await Promise.all([
    safeSearch(tickerQuery, maxResults),
    fetchMacro(),
    deriveAngles({ symbol: args.symbol, companyName: args.companyName }),
  ])

  const contextualResults = await Promise.all(angleRes.queries.map(q => safeSearch(q, 4)))
  const contextualRaw = contextualResults.flatMap(r => r.results)
  const contextualFailed = contextualResults.some(r => r.failed)

  const seen = new Set<string>()
  const take = (items: NewsResult[], cap: number): NewsResult[] => {
    const out: NewsResult[] = []
    for (const it of items) {
      if (!it?.url || seen.has(it.url)) continue
      seen.add(it.url)
      out.push(it)
      if (out.length >= cap) break
    }
    return out
  }

  const failures: string[] = []
  if (tickerRes.failed) failures.push('ticker news search failed')
  if (macroRes.failed) failures.push('macro news search failed')
  if (angleRes.failed) failures.push('angle derivation failed')
  else if (contextualFailed) failures.push('sector/peer news search failed')

  // Ticker wins URL ties, then macro, then contextual.
  const result: ContextualNews = {
    ticker: take(tickerRes.results, maxResults),
    macro: take(macroRes.results, MACRO_CAP),
    contextual: take(contextualRaw, CONTEXTUAL_CAP),
  }

  if (failures.length) {
    result.error = failures.join('; ')
  }

  return result
}

// Round-robin merge: takes index 0 of each group, then index 1, etc.,
// skipping exhausted groups. This keeps every group fairly represented
// once a downstream cap is applied.
function interleave<T>(groups: T[][]): T[] {
  const out: T[] = []
  const max = Math.max(0, ...groups.map(g => g.length))
  for (let i = 0; i < max; i++) {
    for (const g of groups) {
      const item = g[i]
      if (item !== undefined) out.push(item)
    }
  }
  return out
}

interface MacroFetchResult {
  results: NewsResult[]
  failed: boolean
}

const MACRO_TTL_MS = 10 * 60 * 1000
let macroCache: { at: number; data: NewsResult[] } | null = null

async function fetchMacro(): Promise<MacroFetchResult> {
  if (macroCache && Date.now() - macroCache.at < MACRO_TTL_MS) {
    return { results: macroCache.data, failed: false }
  }
  const groups = await Promise.all(MACRO_QUERIES.map(q => safeSearch(q, MACRO_CAP)))
  const anyFailed = groups.some(g => g.failed)
  const results = interleave(groups.map(g => g.results))
  // Never cache a partial/failed fetch — retry next call even if we got some results.
  if (!anyFailed) {
    macroCache = { at: Date.now(), data: results }
  }
  // Partial macro outage that still returns data is not surfaced as a failure;
  // cache is still skipped so it retries next call.
  return { results, failed: anyFailed && results.length === 0 }
}
