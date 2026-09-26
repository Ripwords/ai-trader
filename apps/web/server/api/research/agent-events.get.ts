import { createError, createEventStream, defineEventHandler, getHeader, getQuery } from 'h3'
import { eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'
import { tailRun } from '../../lib/agents/run-events'

const PING_MS = 15_000

function parseSeq(v: unknown): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : Number.NaN
  return Number.isFinite(n) ? n : -1
}

/**
 * GET /api/research/agent-events?run_id=<id>&after=<seq>
 *
 * Server-sent events for one run: every persisted event after `after` (or the
 * browser's Last-Event-ID on reconnect), then new ones as the drain writes
 * them. Each message's id is its seq. Ends with an `end` event carrying the
 * terminal status; the client must close the EventSource on it, or the
 * browser reconnects.
 */
export default defineEventHandler(async (event) => {
  const userId = await getOwnerId()
  const { run_id, after } = getQuery(event)
  if (typeof run_id !== 'string' || run_id.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'run_id required' })
  }
  const [run] = await getDb()
    .select({ userId: agentRuns.userId })
    .from(agentRuns)
    .where(eq(agentRuns.id, run_id))
    .limit(1)
  if (!run || run.userId !== userId) {
    throw createError({ statusCode: 404, statusMessage: 'run not found' })
  }

  const lastEventId = getHeader(event, 'last-event-id')
  const afterSeq = parseSeq(lastEventId ?? after)

  const stream = createEventStream(event)
  const ac = new AbortController()
  const ping = setInterval(() => {
    stream.push({ event: 'ping', data: '' }).catch(() => {})
  }, PING_MS)
  stream.onClosed(() => {
    clearInterval(ping)
    ac.abort()
  })

  void (async () => {
    try {
      for await (const frame of tailRun(run_id, { afterSeq, signal: ac.signal })) {
        if (frame.kind === 'event') {
          await stream.push({ id: String(frame.seq), data: JSON.stringify(frame.event) })
        } else {
          await stream.push({ event: 'end', data: JSON.stringify({ status: frame.status, error: frame.error }) })
        }
      }
    } catch (e: unknown) {
      console.error('[agent-events] tail failed', (e as Error)?.message)
    } finally {
      clearInterval(ping)
      await stream.close().catch(() => {})
    }
  })()

  return stream.send()
})
