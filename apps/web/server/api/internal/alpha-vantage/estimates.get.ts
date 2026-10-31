import { createError, defineEventHandler, getQuery } from 'h3'
import { getEstimateRevisions } from '../../../lib/alpha-vantage'
import { requireInternalBearer } from '../_guard'

/** Consensus history and revisions per period; quota states return 200 `unavailable`. */
export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  return getEstimateRevisions(symbol)
})
