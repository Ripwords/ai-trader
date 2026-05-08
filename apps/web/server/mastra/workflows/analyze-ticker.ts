import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { getOwnerId, recordResearchSignal } from '../../db/repo'
import { getResearchApi } from '../../llm/http'
import { findPersona, runPersona } from '../../llm/personas'
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

const fetchBundleStep = createStep({
  id: 'fetch-bundle',
  inputSchema: InputSchema,
  outputSchema: InputSchema.extend({ bundle: z.unknown().nullable() }),
  execute: async ({ inputData }) => {
    const bundle = await getResearchApi().getBundle(inputData.symbol).catch((err: unknown) => {
      console.error('[analyze-ticker] bundle fetch failed', err)
      return null
    })
    return { ...inputData, bundle }
  },
})

const collectSignalsStep = createStep({
  id: 'collect-signals',
  inputSchema: InputSchema.extend({ bundle: z.unknown().nullable() }),
  outputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
  }),
  execute: async ({ inputData }) => {
    const api = getResearchApi()
    const analystResults = await Promise.all(
      inputData.analysts.map(async (name: AnalystName): Promise<Signal | null> => {
        try {
          return await api.runAnalyst(name, inputData.symbol)
        } catch (err) {
          console.error(`[analyze-ticker] analyst ${name} failed`, err)
          return null
        }
      }),
    )
    const personaResults = inputData.bundle === null
      ? []
      : await Promise.all(
        inputData.personas.map(async (id: PersonaName): Promise<Signal | null> => {
          const persona = findPersona(id)
          if (!persona) return null
          try {
            return await runPersona(persona, inputData.symbol, inputData.bundle)
          } catch (err) {
            console.error(`[analyze-ticker] persona ${id} failed`, err)
            return null
          }
        }),
      )
    const signals = [...analystResults, ...personaResults].filter((s): s is Signal => s !== null)
    return { symbol: inputData.symbol, signals }
  },
})

const persistSignalsStep = createStep({
  id: 'persist-signals',
  inputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
  }),
  outputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
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
  }),
  outputSchema: z.object({
    symbol: z.string(),
    signals: z.array(SignalSchema),
    decision: DecisionSchema.nullable(),
  }),
  execute: async ({ inputData }) => {
    if (inputData.signals.length === 0) {
      return { ...inputData, decision: null }
    }
    try {
      const result = await getResearchApi().synthesizeDecisions({
        symbols: [inputData.symbol],
        signals: inputData.signals,
        portfolio: { cash: 100_000, total_value: 100_000, positions: {} },
      })
      const first = (result.decisions ?? [])[0] as Decision | undefined
      return { ...inputData, decision: first ?? null }
    } catch (err) {
      console.error('[analyze-ticker] synthesis failed', err)
      return { ...inputData, decision: null }
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
