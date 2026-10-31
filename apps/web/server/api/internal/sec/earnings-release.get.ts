import { createError, defineEventHandler, getQuery } from 'h3'
import { getLatestEarningsRelease } from '../../../lib/sec-edgar'
import { requireInternalBearer } from '../_guard'

/**
 * Latest earnings press release (8-K Item 2.02, EX-99.1) as readable text,
 * with the filing and exhibit URLs. Used by the agents' get_earnings_release.
 * Caching lives in the lib (Nitro cache, Redis-backed when configured).
 */
export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  try {
    return await getLatestEarningsRelease(symbol)
  } catch (err) {
    console.error('[internal/sec/earnings-release] failed', symbol, err)
    throw createError({ statusCode: 502, statusMessage: 'SEC EDGAR request failed' })
  }
})
