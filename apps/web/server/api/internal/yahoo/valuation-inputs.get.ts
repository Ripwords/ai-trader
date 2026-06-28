import { createError, defineEventHandler, getQuery } from 'h3'
import { getDailyBars, getFinancialMetrics, getHistorical } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const [metrics, history, dailyBars] = await Promise.all([
    getFinancialMetrics(symbol),
    getHistorical(symbol, 6),
    getDailyBars(symbol, 252),
  ])
  return { symbol, metrics, history, dailyBars }
})
