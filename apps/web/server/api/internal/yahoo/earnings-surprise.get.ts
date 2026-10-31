import { createError, defineEventHandler, getQuery } from 'h3'
import { getEarningsSurprise } from '../../../lib/earnings-surprise'
import { requireInternalBearer } from '../_guard'

/** Consensus vs actual EPS for recent quarters plus forward consensus. */
export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  try {
    return await getEarningsSurprise(symbol)
  } catch (err) {
    console.error('[internal/yahoo/earnings-surprise] failed', symbol, err)
    throw createError({ statusCode: 502, statusMessage: 'Yahoo earnings request failed' })
  }
})
