import { createError, defineEventHandler, getQuery } from 'h3'
import { getFundamentalsBundle } from '../../lib/yahoo'
import { requireInternalBearer } from '../_guard'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const bundle = await getFundamentalsBundle(symbol)
  return {
    symbol: bundle.symbol,
    income_statement: bundle.income_statement ?? null,
  }
})
