import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { getOwnerId, recordResearchSignal } from '../../db/repo'
import { getResearchApi } from '../../llm/http'
import { findPersona, runPersona } from '../../llm/personas'
import {
  getCompanyNews,
  getFinancialMetrics,
  getHistorical,
  getInsiderTrades,
  type FinancialMetrics,
  type InsiderTrade,
  type NewsItem,
} from '../../lib/yahoo'
import { getHoldingForSymbol, getPaperPortfolioSlice, type HoldingSummary } from '../../lib/holdings'
import type { AnalystName, Decision, PersonaName, Signal } from '../../../types/research'

const ANALYSTS = ['fundamentals', 'valuation', 'technicals', 'sentiment'] as const
const PERSONAS = ['buffett', 'munger', 'burry', 'druckenmiller', 'wood'] as const

const SignalSchema = z.object({
  source: z.string(),
  symbol: z.string(),
  signal: z.enum(['bullish', 'bearish', 'neutral']),
  confidence: z.number(),
  reasoning: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const DecisionSchema = z.object({
  symbol: z.string(),
  action: z.enum(['buy', 'sell', 'short', 'cover', 'hold']),
  quantity: z.number(),
  confidence: z.number(),
  reasoning: z.string(),
})

const InputSchema = z.object({
  symbol: z.string(),
  analysts: z.array(z.enum(ANALYSTS)).default([...ANALYSTS]),
  personas: z.array(z.enum(PERSONAS)).default([...PERSONAS]),
})

const OutputSchema = z.object({
  symbol: z.string(),
  signals: z.array(SignalSchema),
  decision: DecisionSchema.nullable(),
  report: z.string(),
})

const FetchedSchema = InputSchema.extend({
  metrics: z.unknown(),
  history: z.array(z.unknown()),
  insider: z.array(z.unknown()),
  news: z.array(z.unknown()),
  holdings: z.unknown(),
})

const fetchBundleStep = createStep({
  id: 'fetch-bundle',
  inputSchema: InputSchema,
  outputSchema: FetchedSchema,
  execute: async ({ inputData }) => {
    const [metrics, history, insider, news, holdings] = await Promise.all([
      getFinancialMetrics(inputData.symbol),
      getHistorical(inputData.symbol, 5),
      getInsiderTrades(inputData.symbol, 200),
      getCompanyNews(inputData.symbol, 50),
      getHoldingForSymbol(inputData.symbol),
    ])
    return { ...inputData, metrics, history, insider, news, holdings }
  },
})

const collectSignalsStep = createStep({
  id: 'collect-signals',
  inputSchema: FetchedSchema,
  outputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
    holdings: z.unknown(),
  }),
  execute: async ({ inputData }) => {
    const api = getResearchApi()
    const metrics = inputData.metrics as FinancialMetrics
    const insider = inputData.insider as InsiderTrade[]
    const news = inputData.news as NewsItem[]
    const holdings = inputData.holdings as HoldingSummary
    const bundle = { metrics, history: inputData.history }

    const analystResults = await Promise.all(
      inputData.analysts.map(async (name: AnalystName): Promise<Signal | null> => {
        try {
          if (name === 'fundamentals' || name === 'valuation') {
            return await api.runAnalyst(name, { symbol: inputData.symbol, metrics })
          }
          if (name === 'sentiment') {
            return await api.runAnalyst(name, { symbol: inputData.symbol, insider, news })
          }
          return await api.runAnalyst(name, { symbol: inputData.symbol })
        } catch (err) {
          console.error(`[analyze-ticker] analyst ${name} failed`, err)
          return null
        }
      }),
    )

    const personaResults = await Promise.all(
      inputData.personas.map(async (id: PersonaName): Promise<Signal | null> => {
        const persona = findPersona(id)
        if (!persona) return null
        try {
          return await runPersona(persona, inputData.symbol, bundle, holdings)
        } catch (err) {
          console.error(`[analyze-ticker] persona ${id} failed`, err)
          return null
        }
      }),
    )

    const signals = [...analystResults, ...personaResults].filter((s): s is Signal => s !== null)
    return { symbol: inputData.symbol, signals, holdings }
  },
})

const persistSignalsStep = createStep({
  id: 'persist-signals',
  inputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
    holdings: z.unknown(),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
    holdings: z.unknown(),
  }),
  execute: async ({ inputData }) => {
    const ownerId = await getOwnerId()
    await Promise.all(
      inputData.signals.map(s =>
        recordResearchSignal(ownerId, {
          symbol: s.symbol,
          source: s.source,
          signal: s.signal,
          confidence: s.confidence,
          reasoning: s.reasoning,
          metadata: s.metadata ?? null,
        }),
      ),
    )
    return inputData
  },
})

const synthesizeStep = createStep({
  id: 'synthesize',
  inputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
    holdings: z.unknown(),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
    decision: DecisionSchema.nullable(),
  }),
  execute: async ({ inputData }) => {
    const { signals, holdings: holdingsRaw, symbol } = inputData
    const holdings = holdingsRaw as HoldingSummary | undefined
    if (signals.length === 0) {
      return { symbol, signals, decision: null }
    }
    try {
      // Use paper cash + paper positions for synthesis sizing — these are
      // experiment trades (the algo/scheduler path is paper-only, and chat-driven
      // synthesis is read-only advice). Falls back to ghostfolio net worth, then
      // to a hardcoded $100k if no broker data is available at all.
      const paper = await getPaperPortfolioSlice()
      const hasPaper = paper.cash_paper_usd > 0 || paper.paper_total_value > 0
      let portfolio: { cash: number; total_value: number; positions: Record<string, number> }
      if (hasPaper) {
        const positions: Record<string, number> = { ...paper.paper_positions_by_symbol }
        portfolio = {
          cash: paper.cash_paper_usd,
          total_value: paper.paper_total_value || (paper.cash_paper_usd + Object.values(positions).reduce((a, b) => a + b, 0)),
          positions,
        }
      } else if (holdings?.net_worth_total && holdings.net_worth_total > 0) {
        portfolio = { cash: 0, total_value: holdings.net_worth_total, positions: {} }
      } else {
        portfolio = { cash: 100_000, total_value: 100_000, positions: {} }
      }

      const result = await getResearchApi().synthesizeDecisions({
        symbols: [symbol],
        signals,
        portfolio,
      })
      const first = (result.decisions ?? [])[0] as Decision | undefined
      return { symbol, signals, decision: first ?? null }
    } catch (err) {
      console.error('[analyze-ticker] synthesis failed', err)
      return { symbol, signals, decision: null }
    }
  },
})

const formatReportStep = createStep({
  id: 'format-report',
  inputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
    decision: DecisionSchema.nullable(),
  }),
  outputSchema: OutputSchema,
  execute: async ({ inputData }) => {
    const lines: string[] = [`# Comprehensive analysis: ${inputData.symbol}`, '']
    if (inputData.signals.length === 0) {
      lines.push('_No signals returned — fundamentals data may be unavailable._')
    } else {
      const grouped = new Map<string, Signal[]>()
      for (const s of inputData.signals) {
        const kind = s.source.startsWith('persona:') ? 'Personas' : 'Analysts'
        const arr = grouped.get(kind) ?? []
        arr.push(s)
        grouped.set(kind, arr)
      }
      for (const [kind, signals] of grouped) {
        lines.push(`## ${kind}`, '')
        for (const s of signals) {
          const label = s.source.replace('persona:', '')
          lines.push(`**${label}** — ${s.signal} (${s.confidence}% confidence)`)
          lines.push(s.reasoning, '')
        }
      }
    }
    if (inputData.decision) {
      const d = inputData.decision
      lines.push('## Final decision', '', `**${d.action.toUpperCase()} ${d.quantity} ${d.symbol}** (${d.confidence}% confidence)`, '', d.reasoning)
    }
    return {
      symbol: inputData.symbol,
      signals: inputData.signals,
      decision: inputData.decision,
      report: lines.join('\n'),
    }
  },
})

export const analyzeTickerWorkflow = createWorkflow({
  id: 'analyze-ticker',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .then(fetchBundleStep)
  .then(collectSignalsStep)
  .then(persistSignalsStep)
  .then(synthesizeStep)
  .then(formatReportStep)
  .commit()
