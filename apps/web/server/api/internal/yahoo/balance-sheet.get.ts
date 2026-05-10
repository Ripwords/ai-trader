import { createError, defineEventHandler, getQuery } from 'h3'
import { getFundamentalsBundle } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'
import { cacheGet, cacheSet } from '../_cache'

interface BalanceSheetResponse {
  symbol: string
  balance_sheet: unknown
}

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  // Cache per (route, symbol) for 24h. The TradingAgents toolkit calls
  // each /internal/yahoo route multiple times per run (once per analyst
  // that consumes fundamentals); without a cache we re-fetch from Yahoo
  // 4-8x per run.
  const cacheKey = `yahoo:balance-sheet:${symbol}`
  const cached = cacheGet<BalanceSheetResponse>(cacheKey)
  if (cached) return cached

  const bundle = await getFundamentalsBundle(symbol)
  const out: BalanceSheetResponse = {
    symbol: bundle.symbol,
    balance_sheet: bundle.balance_sheet ?? null,
  }
  cacheSet(cacheKey, out)
  return out
})
