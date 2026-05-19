import type { NewsResult } from './search'
import { searchWithFallback } from './search'
import { deriveAngles } from './contextual-news-angles'

export interface ContextualNews {
  ticker: NewsResult[]
  macro: NewsResult[]
  contextual: NewsResult[]
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

async function safeSearch(query: string, max: number): Promise<NewsResult[]> {
  try {
    return await searchWithFallback('news', query, max)
  } catch {
    return []
  }
}

export async function getContextualNews(
  args: GetContextualNewsArgs,
): Promise<ContextualNews> {
  const maxResults = args.maxResults ?? 10
  const tickerQuery = args.companyName
    ? `${args.companyName} ${args.symbol}`
    : args.symbol

  const [tickerRaw, macroRaw, angleQueries] = await Promise.all([
    safeSearch(tickerQuery, maxResults),
    fetchMacro(),
    deriveAngles({ symbol: args.symbol, companyName: args.companyName }),
  ])

  const contextualRaw = (
    await Promise.all(angleQueries.map(q => safeSearch(q, 4)))
  ).flat()

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

  // Ticker wins URL ties, then macro, then contextual.
  return {
    ticker: take(tickerRaw, maxResults),
    macro: take(macroRaw, MACRO_CAP),
    contextual: take(contextualRaw, CONTEXTUAL_CAP),
  }
}

async function fetchMacro(): Promise<NewsResult[]> {
  const groups = await Promise.all(MACRO_QUERIES.map(q => safeSearch(q, MACRO_CAP)))
  return groups.flat()
}
