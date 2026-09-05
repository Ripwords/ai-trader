import { defineEventHandler, getQuery, createError } from 'h3'
import { and, eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'

export default defineEventHandler(async (event) => {
  const userId = await getOwnerId()
  const { run_id } = getQuery(event)
  if (typeof run_id !== 'string') throw createError({ statusCode: 400 })

  const apiBase = process.env.NUXT_API_BASE_URL ?? 'http://api:8000'
  const internalBearer = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER ?? ''
  const upstream = await fetch(`${apiBase}/agents/run/${run_id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${internalBearer}` },
  }).catch(() => null)
  // Marking the row cancelled while the pipeline keeps running (and
  // billing) would be a lie the UI repeats; surface the failure instead.
  if (!upstream || !upstream.ok) {
    throw createError({
      statusCode: 502,
      statusMessage: upstream ? `agents service refused the cancel (${upstream.status})` : 'agents service unreachable',
    })
  }

  const db = getDb()
  await db
    .update(agentRuns)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(agentRuns.id, run_id), eq(agentRuns.userId, userId)))
  return { ok: true }
})
