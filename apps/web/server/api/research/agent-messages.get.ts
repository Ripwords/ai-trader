import { defineEventHandler, getQuery, createError } from 'h3'
import { and, asc, eq, gt } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns, agentMessages } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'
import type { AgentEvent } from '../../../types/agents'

/**
 * GET /api/research/agent-messages
 *
 * Replay the persisted event log for a run. Used by the research page to
 * rehydrate state after a refresh or when a user opens ``?run=<id>``: every
 * event we've streamed has been tee'd to ``agent_messages`` so the page can
 * reconstruct the timeline without holding the original SSE connection.
 *
 * Query params:
 *   - ``run_id`` (required) — the run to replay
 *   - ``since``  (optional) — return only messages with ``seq > since``;
 *                             callers pass the last seq they've seen so the
 *                             poll loop incrementally appends new events
 *                             instead of re-downloading everything every tick
 *
 * Response:
 *   ``{ runId, status, finishedAt, lastSeq, events: AgentEvent[] }``
 *
 * Owner-scoped: requesting a run that belongs to a different user returns 404
 * to avoid leaking existence.
 */
export default defineEventHandler(async (event) => {
  const userId = await getOwnerId()
  const { run_id, since } = getQuery(event)

  if (typeof run_id !== 'string' || run_id.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'run_id required' })
  }

  const sinceSeq = (() => {
    if (typeof since !== 'string' || since.length === 0) return -1
    const n = Number.parseInt(since, 10)
    return Number.isFinite(n) ? n : -1
  })()

  const db = getDb()

  // Fetch the run row first to authorise + return current status/timestamps.
  const runRows = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      userId: agentRuns.userId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, run_id))
    .limit(1)
  const run = runRows[0]
  if (!run || run.userId !== userId) {
    throw createError({ statusCode: 404, statusMessage: 'run not found' })
  }

  const filters = [eq(agentMessages.runId, run_id)]
  if (sinceSeq >= 0) filters.push(gt(agentMessages.seq, sinceSeq))
  const rows = await db
    .select({
      seq: agentMessages.seq,
      payload: agentMessages.payload,
    })
    .from(agentMessages)
    .where(filters.length === 1 ? filters[0]! : and(...filters)!)
    .orderBy(asc(agentMessages.seq))
    .limit(2000)

  const events: AgentEvent[] = rows.map(r => r.payload as AgentEvent)
  const lastSeq = rows.length > 0 ? rows[rows.length - 1]!.seq : sinceSeq

  return {
    runId: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastSeq,
    events,
  }
})
