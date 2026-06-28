import { resolveSymbol, getFinancialMetrics } from '../../lib/yahoo'
import { getContextualNews } from '../../lib/contextual-news'
import { extractTickerCandidates } from '../recall'

export interface DypContext {
  question: string
  symbol: string | null
  companyName: string | null
  fundamentals: unknown | null
  valuation: unknown | null
  news: unknown | null
}

export async function gatherDypContext(
  opts: { question: string; symbol?: string; baseUrl: string; sessionCookie?: string },
): Promise<DypContext> {
  const base: DypContext = { question: opts.question, symbol: null, companyName: null, fundamentals: null, valuation: null, news: null }

  const candidate = opts.symbol ?? extractTickerCandidates(opts.question, 1)[0]
  if (!candidate) return base
  const resolution = await resolveSymbol(candidate)
  if (resolution.status !== 'resolved') return base

  const symbol = resolution.symbol
  base.symbol = symbol
  base.companyName = resolution.name

  // Light, best-effort bundle — never throw out of the gatherer.
  base.fundamentals = await getFinancialMetrics(symbol).catch(() => null)
  base.valuation = await fetch(`${opts.baseUrl}/api/research/valuation?symbol=${encodeURIComponent(symbol)}`, {
    headers: { ...(opts.sessionCookie ? { cookie: opts.sessionCookie } : {}) },
  }).then(r => r.ok ? r.json() : null).catch(() => null)
  base.news = await getContextualNews({ symbol, companyName: resolution.name, maxResults: 6 }).catch(() => null)
  return base
}
