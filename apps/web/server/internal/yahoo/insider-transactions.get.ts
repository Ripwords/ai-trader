import { createError, defineEventHandler, getQuery } from 'h3'
import { getInsiderTrades } from '../../lib/yahoo'
import { requireInternalBearer } from '../_guard'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const transactions = await getInsiderTrades(symbol, 20)
  return { symbol, transactions }
})
