import { recordResearchSignal } from '../db/repo'
import { getResearchApi } from '../llm/http'
import { findPersona, runPersona } from '../llm/personas'
import {
  getCompanyNews,
  getEarningsInfo,
  getFinancialMetrics,
  getHistorical,
  getInsiderTrades,
} from './yahoo'
import { getHoldingForSymbol } from './holdings'
import type {
  AnalystName,
  PersonaName,
  ResearchEvent,
  ResearchSourceName,
  Signal,
} from '../../types/research'

interface PipelineInput {
  ownerId: string
  symbol: string
  analysts: AnalystName[]
  personas: PersonaName[]
  signal?: AbortSignal
}

interface SourceResult {
  source: ResearchSourceName
  signal?: Signal
  error?: string
}

/**
 * Streams per-source results as analyst + persona promises resolve.
 *
 * Yields:
 *   - one `progress` event per requested source (up-front, so the UI can
 *     render skeletons in stable order)
 *   - one `signal` or `error` event per source as it completes
 *   - one terminal `done` event
 *
 * Honors `signal.aborted` between yields so a client disconnect halts
 * iteration; in-flight network promises can't be cancelled (no AbortSignal
 * support in moomoo client / Yahoo lib), but their results are simply
 * dropped when the generator is GC'd.
 */
export async function* runResearchPipeline(input: PipelineInput): AsyncGenerator<ResearchEvent> {
  const { ownerId, symbol, analysts, personas, signal: abortSignal } = input

  // Stable order: emit progress for every selected source first so the page
  // can render placeholder cards in the same order as in the UI selection.
  for (const a of analysts) yield { kind: 'progress', source: a, phase: 'started' }
  for (const p of personas) yield { kind: 'progress', source: p, phase: 'started' }

  // Shared inputs used by multiple sources. These are cached at the lib layer
  // (yahoo.ts) so concurrent calls within a single run are deduped naturally.
  const [metrics, history, insider, news, holdings, earnings] = await Promise.all([
    getFinancialMetrics(symbol),
    getHistorical(symbol, 5),
    getInsiderTrades(symbol, 200),
    getCompanyNews(symbol, 50),
    getHoldingForSymbol(symbol),
    getEarningsInfo(symbol),
  ])
  const bundle = { metrics, history }

  if (abortSignal?.aborted) return

  const api = getResearchApi()
  const tasks: Promise<SourceResult>[] = []

  for (const name of analysts) {
    tasks.push((async (): Promise<SourceResult> => {
      try {
        const sig = name === 'fundamentals' || name === 'valuation'
          ? await api.runAnalyst(name, { symbol, metrics })
          : name === 'sentiment'
            ? await api.runAnalyst(name, { symbol, insider, news })
            : await api.runAnalyst(name, { symbol })
        await recordResearchSignal(ownerId, sig)
        return { source: name, signal: sig }
      } catch (err) {
        return { source: name, error: err instanceof Error ? err.message : String(err) }
      }
    })())
  }

  for (const name of personas) {
    tasks.push((async (): Promise<SourceResult> => {
      const persona = findPersona(name)
      if (!persona) return { source: name, error: 'unknown persona' }
      try {
        const sig = await runPersona(persona, symbol, bundle, holdings, earnings)
        await recordResearchSignal(ownerId, sig)
        return { source: name, signal: sig }
      } catch (err) {
        return { source: name, error: err instanceof Error ? err.message : String(err) }
      }
    })())
  }

  // Yield each task as it resolves. We tag each promise with its index so we
  // can identify and remove it from the pending set after Promise.race wins.
  // (Already-settled promises in subsequent races are cheap microtasks.)
  const wrapped = tasks.map((p, i) => p.then((v): [number, SourceResult] => [i, v]))
  const pending = new Set<number>(tasks.map((_, i) => i))

  while (pending.size > 0) {
    if (abortSignal?.aborted) return
    const [idx, result] = await Promise.race([...pending].map(i => wrapped[i]!))
    pending.delete(idx)
    if (result.signal) {
      yield { kind: 'signal', source: result.source, signal: result.signal }
    } else {
      yield {
        kind: 'error',
        source: result.source,
        message: result.error ?? 'unknown error',
        fatal: false,
      }
    }
  }

  yield { kind: 'done' }
}
