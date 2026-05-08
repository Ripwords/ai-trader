import { getApiClient } from '../../llm/http'
import type { SynthesisRequest, SynthesisResponse } from '../../../types/research'

export default defineEventHandler(async (event): Promise<SynthesisResponse> => {
  const body = await readBody<SynthesisRequest>(event)
  if (!body || !Array.isArray(body.signals) || body.signals.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'signals required' })
  }
  const symbols = Array.isArray(body.symbols) && body.symbols.length > 0
    ? body.symbols
    : Array.from(new Set(body.signals.map(s => s.symbol)))

  const client = getApiClient()
  return client.post<SynthesisResponse>('/synthesis/decide', {
    symbols,
    signals: body.signals,
    portfolio: body.portfolio ?? null,
  })
})
