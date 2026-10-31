import { createError, defineEventHandler, getQuery } from 'h3'
import { getEarningsCallTranscript } from '../../../lib/alpha-vantage'
import { requireInternalBearer } from '../_guard'

/**
 * Earnings-call transcript (prepared remarks + Q&A). Quota and missing-key
 * states come back as `status: 'unavailable'` with 200, not as errors.
 */
export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol, quarter } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  return getEarningsCallTranscript(symbol, typeof quarter === 'string' && quarter.trim() ? quarter : undefined)
})
