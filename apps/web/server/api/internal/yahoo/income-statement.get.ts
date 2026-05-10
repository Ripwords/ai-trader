import { createError, defineEventHandler, getQuery } from 'h3'
import { getFundamentalsBundle } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'
import { cacheGet, cacheSet } from '../_cache'

interface IncomeStatementResponse {
  symbol: string
  income_statement: unknown
}

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const cacheKey = `yahoo:income-statement:${symbol}`
  const cached = cacheGet<IncomeStatementResponse>(cacheKey)
  if (cached) return cached

  const bundle = await getFundamentalsBundle(symbol)
  const out: IncomeStatementResponse = {
    symbol: bundle.symbol,
    income_statement: bundle.income_statement ?? null,
  }
  cacheSet(cacheKey, out)
  return out
})
