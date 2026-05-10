import { defineEventHandler, getQuery } from 'h3'
import { eq, desc, and } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns, agentDecisions, agentReflections } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'

export default defineEventHandler(async (event) => {
  const userId = await getOwnerId()
  const { symbol } = getQuery(event)

  const db = getDb()
  const where = symbol && typeof symbol === 'string'
    ? and(eq(agentRuns.userId, userId), eq(agentRuns.symbol, symbol))
    : eq(agentRuns.userId, userId)

  const rows = await db
    .select({
      id: agentRuns.id,
      symbol: agentRuns.symbol,
      tradeDate: agentRuns.tradeDate,
      status: agentRuns.status,
      tokensIn: agentRuns.tokensIn,
      tokensOut: agentRuns.tokensOut,
      costUsd: agentRuns.costUsd,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      rating: agentDecisions.rating,
      confidence: agentDecisions.confidence,
      alpha: agentReflections.alpha,
      outcome: agentReflections.outcome,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .leftJoin(agentReflections, eq(agentReflections.decisionId, agentDecisions.id))
    .where(where)
    .orderBy(desc(agentRuns.startedAt))
    .limit(50)

  return { rows }
})
