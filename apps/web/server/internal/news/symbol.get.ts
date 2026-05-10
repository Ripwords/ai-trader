import { createError, defineEventHandler, getQuery } from 'h3'
import { searchWithFallback } from '../../lib/search'
import { requireInternalBearer } from '../_guard'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol, max_results } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const limit = Math.min(parseInt((max_results as string) ?? '10', 10) || 10, 25)
  try {
    const results = await searchWithFallback('news', symbol, limit)
    return { symbol, results }
  } catch (e: unknown) {
    return { symbol, results: [], error: (e as Error)?.message ?? 'search failed' }
  }
})
