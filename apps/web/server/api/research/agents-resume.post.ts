import { defineEventHandler, readBody, createError } from 'h3'
import { eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'
import { AgentRunTee } from '../../utils/agents-tee'
import type { AgentEvent } from '../../../types/agents'

/**
 * POST /api/research/agents-resume
 *
 * Resume a previously-failed/cancelled agent run from its last LangGraph
 * checkpoint. Mirrors ``agents-run.post.ts`` but:
 *
 *   1. Looks up the existing ``agent_runs`` row instead of inserting a new one.
 *   2. Verifies ownership (the run must belong to the calling user).
 *   3. Calls upstream ``POST /agents/run/{id}/resume`` rather than ``/agents/run``.
 *   4. Reuses the same ``run_id`` for the tee so all events accumulate against
 *      the original run.
 *
 * The upstream endpoint relies on ``app.state.checkpointer`` being wired
 * (Task 8.2). When the saver isn't available — e.g. during a partial deploy —
 * the upstream stream will simply emit ``run-end`` with no replayed events
 * and the UI will mark the run complete. That degrades gracefully without
 * a 5xx, which is the right tradeoff for a v1 nice-to-have.
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

  // Flip the row back to ``running`` so the History table reflects the
  // in-flight resume. Clear ``error`` so a stale failure message doesn't
  // confuse the UI if the resume itself succeeds. ``finishedAt`` is left as
  // is; the tee will overwrite it on the trailing ``run-end``.
  await db.update(agentRuns).set({ status: 'running', error: null }).where(eq(agentRuns.id, run.id))

  const apiBase = process.env.NUXT_API_BASE_URL ?? 'http://api:8000'
  const internalBearer = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER ?? ''
  const upstream = await fetch(`${apiBase}/agents/run/${run.id}/resume`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${internalBearer}`,
      'x-user-id': userId,
    },
  })

  if (!upstream.ok || !upstream.body) {
    await db
      .update(agentRuns)
      .set({ status: 'failed', error: `upstream ${upstream.status}` })
      .where(eq(agentRuns.id, run.id))
    throw createError({ statusCode: 502, statusMessage: 'upstream agents service failed' })
  }

  const tee = new AgentRunTee(run.id, userId)
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let teeBuf = ''
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) {
        const trimmed = teeBuf.trim()
        if (trimmed) {
          try {
            tee.push(JSON.parse(trimmed) as AgentEvent)
          } catch {
            /* skip malformed */
          }
        }
        controller.close()
        return
      }
      controller.enqueue(value)
      teeBuf += decoder.decode(value, { stream: true })
      const lines = teeBuf.split('\n')
      teeBuf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          tee.push(JSON.parse(trimmed) as AgentEvent)
        } catch {
          /* skip malformed */
        }
      }
    },
    cancel() {
      void reader.cancel()
    },
  })

  event.node.res.setHeader('content-type', 'application/x-ndjson')
  event.node.res.setHeader('cache-control', 'no-store')
  return stream
})
