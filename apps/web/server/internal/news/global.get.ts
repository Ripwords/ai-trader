import { defineEventHandler, getQuery } from 'h3'
import { searchWithFallback } from '../../lib/search'
import { requireInternalBearer } from '../_guard'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { query, max_results } = getQuery(event)
  const q = (typeof query === 'string' && query) || 'global macroeconomic news'
  const limit = Math.min(parseInt((max_results as string) ?? '10', 10) || 10, 25)
  try {
    const results = await searchWithFallback('news', q, limit)
    return { query: q, results }
  } catch (e: unknown) {
    return { query: q, results: [], error: (e as Error)?.message ?? 'search failed' }
  }
})
