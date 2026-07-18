import { createError, defineEventHandler, getQuery } from 'h3'
import type { HistoricalPeriod, QuarterlyPeriod } from '../../../lib/yahoo'
import { getHistorical, getQuarterlyHistory } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'
import { cacheGet, cacheSet } from '../_cache'

interface StatementHistoryResponse {
  symbol: string
  freq: 'annual' | 'quarterly'
  /** Most-recent-first, matching getHistorical/getQuarterlyHistory. */
  periods: HistoricalPeriod[] | QuarterlyPeriod[]
}

const MAX_PERIODS = 12

/**
 * Multi-period statement history for the TradingAgents toolkit.
 *
 * ``?freq=annual`` (default) returns up to N annual periods from
 * ``getHistorical`` (revenue, net income, FCF, debt, assets, equity);
 * ``?freq=quarterly`` returns up to N quarters from ``getQuarterlyHistory``
 * (revenue, net income, operating income, EPS). ``?periods=N`` caps at 12.
 */
export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol, freq: rawFreq, periods: rawPeriods } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const freq = typeof rawFreq === 'string' && rawFreq ? rawFreq : 'annual'
  if (freq !== 'annual' && freq !== 'quarterly') {
    throw createError({ statusCode: 400, statusMessage: 'freq must be annual or quarterly' })
  }
  const requested = Number(rawPeriods)
  const fallback = freq === 'annual' ? 5 : 8
  const n = Number.isFinite(requested) && requested > 0
    ? Math.min(MAX_PERIODS, Math.floor(requested))
    : fallback

  const cacheKey = `yahoo:statement-history:${symbol}:${freq}:${n}`
  const cached = cacheGet<StatementHistoryResponse>(cacheKey)
  if (cached) return cached

  const periods = freq === 'annual'
    ? await getHistorical(symbol, n)
    : await getQuarterlyHistory(symbol, n)
  const out: StatementHistoryResponse = { symbol, freq, periods }
  cacheSet(cacheKey, out)
  return out
})
