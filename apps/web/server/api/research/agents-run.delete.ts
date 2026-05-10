import { defineEventHandler, getQuery, createError } from 'h3'
import { eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'

export default defineEventHandler(async (event) => {
  // ensures auth + side effect of get-or-create
  await getOwnerId()
  const { run_id } = getQuery(event)
  if (typeof run_id !== 'string') throw createError({ statusCode: 400 })

  const apiBase = process.env.NUXT_API_BASE_URL ?? 'http://api:8000'
  const internalBearer = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER ?? ''
  await fetch(`${apiBase}/agents/run/${run_id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${internalBearer}` },
  }).catch(() => null)

  const db = getDb()
  await db
    .update(agentRuns)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(eq(agentRuns.id, run_id))
  return { ok: true }
})
