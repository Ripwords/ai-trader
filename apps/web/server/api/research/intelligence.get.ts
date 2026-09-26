import { desc, eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentDecisions, agentRuns } from '../../../db/schema'
import { buildResearchIntelligence } from '../../lib/research-intelligence'
import { getOwnerId } from '../../db/repo'

export default defineEventHandler(async () => {
  const userId = await getOwnerId()
  const db = getDb()

  const rows = await db
    .select({
      id: agentRuns.id,
      symbol: agentRuns.symbol,
      status: agentRuns.status,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      rating: agentDecisions.rating,
      confidence: agentDecisions.confidence,
      costUsd: agentRuns.costUsd,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(eq(agentRuns.userId, userId))
    .orderBy(desc(agentRuns.startedAt))
    .limit(200)

  return buildResearchIntelligence(rows.map(row => ({
    id: row.id,
    symbol: row.symbol,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    rating: row.rating,
    confidence: row.confidence,
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
  })))
})
