import { searchSymbols, type SymbolSearchResult } from '../../lib/yahoo'

export default defineEventHandler(async (event): Promise<{ results: SymbolSearchResult[] }> => {
  const q = getQuery(event)
  const query = typeof q.q === 'string' ? q.q : ''
  if (query.trim().length < 1) return { results: [] }
  const limit = Math.min(20, Math.max(1, Number(q.limit) || 8))
  const results = await searchSymbols(query, limit)
  return { results }
})
