import { createError, defineEventHandler, getQuery } from 'h3'
import { getInsiderTrades } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'
import { cacheGet, cacheSet } from '../_cache'

interface InsiderResponse {
  symbol: string
  /** Applied lookback window in days, or null when unwindowed. */
  days: number | null
  transactions: Awaited<ReturnType<typeof getInsiderTrades>>
}

const MAX_DAYS = 365

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol, days: rawDays } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  // Optional lookback window. Yahoo's insiderTransactions module has no
  // date-range parameter, so the window is applied here after the fetch.
  const parsed = Number(rawDays)
  const days = Number.isFinite(parsed) && parsed > 0
    ? Math.min(MAX_DAYS, Math.floor(parsed))
    : null

  const cacheKey = `yahoo:insider:${symbol}:${days ?? 'all'}`
  const cached = cacheGet<InsiderResponse>(cacheKey)
  if (cached) return cached

  let transactions = await getInsiderTrades(symbol, 20)
  if (days !== null) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    transactions = transactions.filter(t => t.date >= cutoff)
  }
  const out: InsiderResponse = { symbol, days, transactions }
  cacheSet(cacheKey, out)
  return out
})
