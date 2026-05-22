import { createError, defineEventHandler, getQuery } from 'h3'
import { getDailyBars } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol, limit } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const n = Math.min(500, Math.max(1, Number(limit) || 252))
  return { symbol, bars: await getDailyBars(symbol, n) }
})
