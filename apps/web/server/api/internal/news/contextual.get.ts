import { createError, defineEventHandler, getQuery } from 'h3'
import { getContextualNews } from '../../../lib/contextual-news'
import { requireInternalBearer } from '../_guard'

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol, company, max_results } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const maxResults = Math.min(parseInt((max_results as string) ?? '10', 10) || 10, 25)
  try {
    const groups = await getContextualNews({
      symbol,
      companyName: typeof company === 'string' && company ? company : undefined,
      maxResults,
    })
    return { symbol, ...groups }
  } catch (e: unknown) {
    return {
      symbol,
      ticker: [],
      macro: [],
      contextual: [],
      error: (e as Error)?.message ?? 'search failed',
    }
  }
})
