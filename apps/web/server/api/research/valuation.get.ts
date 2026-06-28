import { createError, defineEventHandler, getQuery } from 'h3'
import { resolveSymbol } from '../../lib/yahoo'

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

  const apiBase = process.env.NUXT_API_BASE_URL ?? 'http://api:8000'
  const internalBearer = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER ?? ''
  const result = await fetch(`${apiBase}/valuation?symbol=${encodeURIComponent(resolution.symbol)}`, {
    headers: { authorization: `Bearer ${internalBearer}` },
  })

  if (!result.ok) {
    throw createError({ statusCode: result.status, statusMessage: 'valuation upstream failed' })
  }

  return await result.json()
})
