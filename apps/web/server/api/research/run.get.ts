import { getOwnerId } from '../../db/repo'
import { runResearchPipeline } from '../../lib/research-pipeline'
import type { AnalystName, PersonaName } from '../../../types/research'

const VALID_ANALYSTS: readonly AnalystName[] = ['fundamentals', 'valuation', 'technicals', 'sentiment'] as const
const VALID_PERSONAS: readonly PersonaName[] = ['buffett', 'munger', 'burry', 'druckenmiller', 'wood'] as const

function parseList<T extends string>(raw: unknown, valid: readonly T[]): T[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  const set = new Set(valid as readonly string[])
  return raw.split(',').map(s => s.trim()).filter((s): s is T => set.has(s))
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const symbol = typeof q.symbol === 'string' ? q.symbol.trim() : ''
  if (!symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const analysts = parseList(q.analysts, VALID_ANALYSTS)
  const personas = parseList(q.personas, VALID_PERSONAS)
  if (analysts.length === 0 && personas.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'at least one analyst or persona required' })
  }

  const ownerId = await getOwnerId()

  const stream = createEventStream(event)
  const ac = new AbortController()

  // 15s heartbeat as `event: ping` defeats reverse-proxy idle timeouts even
  // when no real signals have resolved yet (e.g. a slow persona LLM call).
  const heartbeat = setInterval(() => {
    stream.push({ event: 'ping', data: '' }).catch(() => {
      /* writer closed — onClosed will cleanup */
    })
  }, 15_000)

  stream.onClosed(() => {
    clearInterval(heartbeat)
    ac.abort()
  })

  // Drive the pipeline in the background; return the stream immediately so
  // the connection is established before the first slow promise resolves.
  ;(async () => {
    try {
      for await (const ev of runResearchPipeline({ ownerId, symbol, analysts, personas, signal: ac.signal })) {
        if (ac.signal.aborted) break
        await stream.push({ event: ev.kind, data: JSON.stringify(ev) })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await stream
        .push({ event: 'error', data: JSON.stringify({ kind: 'error', source: 'pipeline', message, fatal: true }) })
        .catch(() => {})
    } finally {
      await stream.close().catch(() => {})
    }
  })()

  return stream.send()
})
