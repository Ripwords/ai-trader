import { defineEventHandler, readBody, createError } from 'h3'
import { and, eq, max } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentMessages, agentRuns } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'
import { drainIntoTee } from '../../lib/agents/start-run'

/**
 * POST /api/research/agents-resume
 *
 * Continue a halted run from its last LangGraph checkpoint under the same
 * run id. The api rebuilds the graph from the options stored in
 * agent_runs.config. Resumed events drain into agent_messages after the run's
 * existing rows, and readers follow them through /api/research/agent-events.
 */
interface AgentsResumeBody {
  run_id?: string
}

export default defineEventHandler(async (event) => {
  const userId = await getOwnerId()
  const body = await readBody<AgentsResumeBody>(event)
  if (!body?.run_id) throw createError({ statusCode: 400, statusMessage: 'run_id required' })

  const db = getDb()
  const rows = await db.select().from(agentRuns).where(eq(agentRuns.id, body.run_id)).limit(1)
  const run = rows[0]
  if (!run) throw createError({ statusCode: 404, statusMessage: 'run not found' })
  if (run.userId !== userId) throw createError({ statusCode: 403, statusMessage: 'forbidden' })
  if (run.status === 'running') throw createError({ statusCode: 409, statusMessage: 'run is still in progress' })

  const [last] = await db
    .select({ maxSeq: max(agentMessages.seq) })
    .from(agentMessages)
    .where(eq(agentMessages.runId, run.id))
  const startSeq = (last?.maxSeq ?? -1) + 1

  await db.update(agentRuns)
    .set({ status: 'running', error: null, finishedAt: null })
    .where(eq(agentRuns.id, run.id))

  const apiBase = process.env.NUXT_API_BASE_URL ?? 'http://api:8000'
  const internalBearer = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER ?? ''
  const upstream = await fetch(`${apiBase}/agents/run/${run.id}/resume`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${internalBearer}`,
      'x-user-id': userId,
    },
  }).catch(() => null)

  if (!upstream?.ok || !upstream.body) {
    await db.update(agentRuns)
      .set({ status: 'failed', error: `upstream ${upstream?.status ?? 'unreachable'}`, finishedAt: new Date() })
      .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'running')))
    throw createError({ statusCode: 502, statusMessage: 'upstream agents service failed' })
  }

  void drainIntoTee(upstream, run.id, userId, { startSeq })
  return { runId: run.id, status: 'running' as const }
})
