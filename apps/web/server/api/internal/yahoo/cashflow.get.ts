import { createError, defineEventHandler, getQuery } from 'h3'
import { getFundamentalsBundle } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'
import { cacheGet, cacheSet } from '../_cache'

interface CashflowResponse {
  symbol: string
  cashflow: unknown
}

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const cacheKey = `yahoo:cashflow:${symbol}`
  const cached = cacheGet<CashflowResponse>(cacheKey)
  if (cached) return cached

  const bundle = await getFundamentalsBundle(symbol)
  const out: CashflowResponse = {
    symbol: bundle.symbol,
    cashflow: bundle.cashflow ?? null,
  }
  cacheSet(cacheKey, out)
  return out
})
