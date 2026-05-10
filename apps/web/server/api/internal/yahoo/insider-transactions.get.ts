import { createError, defineEventHandler, getQuery } from 'h3'
import { getInsiderTrades } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'
import { cacheGet, cacheSet } from '../_cache'

interface InsiderResponse {
  symbol: string
  transactions: Awaited<ReturnType<typeof getInsiderTrades>>
}

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const cacheKey = `yahoo:insider:${symbol}`
  const cached = cacheGet<InsiderResponse>(cacheKey)
  if (cached) return cached

  const transactions = await getInsiderTrades(symbol, 20)
  const out: InsiderResponse = { symbol, transactions }
  cacheSet(cacheKey, out)
  return out
})
