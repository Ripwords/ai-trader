import { createError, defineEventHandler, getQuery } from 'h3'
import { getFundamentalsBundle } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'
import { cacheGet, cacheSet } from '../_cache'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const cacheKey = `yahoo:fundamentals:${symbol}`
  const cached = cacheGet<Awaited<ReturnType<typeof getFundamentalsBundle>>>(cacheKey)
  if (cached) return cached

  const result = await getFundamentalsBundle(symbol)
  cacheSet(cacheKey, result)
  return result
})
