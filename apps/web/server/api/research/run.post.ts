import { getApiClient } from '../../llm/http'
import { getOwnerId, recordResearchSignal } from '../../db/repo'
import type {
  AnalystName,
  PersonaName,
  ResearchRunRequest,
  ResearchRunResponse,
  Signal,
} from '../../../types/research'

const DEFAULT_ANALYSTS: AnalystName[] = ['fundamentals', 'valuation', 'technicals', 'sentiment']

export default defineEventHandler(async (event): Promise<ResearchRunResponse> => {
  const body = await readBody<ResearchRunRequest>(event)
  const symbol = body?.symbol?.trim()
  if (!symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }

  const analysts: AnalystName[] = body.analysts && body.analysts.length > 0 ? body.analysts : DEFAULT_ANALYSTS
  const personas: PersonaName[] = body.personas ?? []

  const ownerId = await getOwnerId()
  const client = getApiClient()

  const analystSignals = await Promise.all(
    analysts.map(async (name): Promise<Signal | null> => {
      try {
        const sig = await client.post<Signal>(`/research/${name}`, { symbol })
        await recordResearchSignal(ownerId, sig)
        return sig
      } catch (err) {
        console.error(`[research/run] analyst ${name} failed`, err)
        return null
      }
    }),
  )

  const personaSignals = await Promise.all(
    personas.map(async (name): Promise<Signal | null> => {
      try {
        const sig = await client.post<Signal>(`/research/persona/${name}`, { symbol })
        await recordResearchSignal(ownerId, sig)
        return sig
      } catch (err) {
        console.error(`[research/run] persona ${name} failed`, err)
        return null
      }
    }),
  )

  const signals = [...analystSignals, ...personaSignals].filter((s): s is Signal => s !== null)
  return { symbol, signals }
})
