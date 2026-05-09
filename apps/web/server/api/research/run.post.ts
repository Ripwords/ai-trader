import { getOwnerId, recordResearchSignal } from '../../db/repo'
import { getResearchApi } from '../../llm/http'
import { findPersona, runPersona } from '../../llm/personas'
import {
  getCompanyNews,
  getEarningsInfo,
  getFinancialMetrics,
  getHistorical,
  getInsiderTrades,
} from '../../lib/yahoo'
import { getHoldingForSymbol } from '../../lib/holdings'
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

  const analysts: AnalystName[] = body.analysts && body.analysts.length > 0
    ? body.analysts
    : DEFAULT_ANALYSTS
  const personas: PersonaName[] = body.personas ?? []

  const ownerId = await getOwnerId()
  const api = getResearchApi()

  const [metrics, history, insider, news, holdings, earnings] = await Promise.all([
    getFinancialMetrics(symbol),
    getHistorical(symbol, 5),
    getInsiderTrades(symbol, 200),
    getCompanyNews(symbol, 50),
    getHoldingForSymbol(symbol),
    getEarningsInfo(symbol),
  ])
  const bundle = { metrics, history }

  const analystSignals = await Promise.all(
    analysts.map(async (name): Promise<Signal | null> => {
      try {
        const sig = name === 'fundamentals' || name === 'valuation'
          ? await api.runAnalyst(name, { symbol, metrics })
          : name === 'sentiment'
            ? await api.runAnalyst(name, { symbol, insider, news })
            : await api.runAnalyst(name, { symbol })
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
      const persona = findPersona(name)
      if (!persona) return null
      try {
        const sig = await runPersona(persona, symbol, bundle, holdings, earnings)
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
