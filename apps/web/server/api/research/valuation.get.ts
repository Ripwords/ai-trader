import { createError, defineEventHandler, getQuery } from 'h3'
import { resolveSymbol } from '../../lib/yahoo'

// The DCF runs over Yahoo fundamentals that are themselves cached for 6h, so
// a fresher valuation would be computed from the same inputs anyway. Keyed on
// the resolved symbol so "aapl" and "AAPL" share one entry; an upstream error
// throws and is never stored.
const fetchValuation = defineCachedFunction(
  async (symbol: string): Promise<unknown> => {
    const apiBase = process.env.NUXT_API_BASE_URL ?? 'http://api:8000'
    const internalBearer = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER ?? ''
    const result = await fetch(`${apiBase}/valuation?symbol=${encodeURIComponent(symbol)}`, {
      headers: { authorization: `Bearer ${internalBearer}` },
    })
    if (!result.ok) {
      throw createError({ statusCode: result.status, statusMessage: 'valuation upstream failed' })
    }
    return await result.json()
  },
  {
    name: 'research-valuation',
    maxAge: 6 * 60 * 60,
    swr: true,
    getKey: (symbol: string) => symbol,
  },
)

export default defineEventHandler(async (event) => {
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }

  const resolution = await resolveSymbol(symbol)
  if (resolution.status !== 'resolved') {
    throw createError({
      statusCode: 422,
      statusMessage: 'symbol could not be uniquely resolved — pick from search',
      data: resolution,
    })
  }

  return await fetchValuation(resolution.symbol)
})
