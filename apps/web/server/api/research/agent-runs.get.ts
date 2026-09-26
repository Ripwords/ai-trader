import { defineEventHandler, getQuery } from 'h3'
import { eq, desc, and, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns, agentDecisions } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'
import { runSymbolPattern } from '../../../types/run-symbol'

/**
 * GET /api/research/agent-runs
 *
 * Query params:
 *   - ``symbol``  — filter to a single ticker (history table on the
 *                   research page)
 *   - ``run_id``  — fetch one specific run (used by Resume to populate
 *                   pre-existing state when the page loads with ``?run=``).
 *                   Always returns at most one row in the ``rows`` array.
 *
 * Both filters are scoped to the current owner; cross-user access returns an
 * empty array (not 403) so the page can render a generic empty state.
 */
export default defineEventHandler(async (event) => {
  const userId = await getOwnerId()
  const { symbol, run_id } = getQuery(event)

  const db = getDb()
  const filters = [eq(agentRuns.userId, userId)]
  if (typeof symbol === 'string' && symbol.length > 0) filters.push(sql`${agentRuns.symbol} ~ ${runSymbolPattern(symbol.toUpperCase())}`)
  if (typeof run_id === 'string' && run_id.length > 0) filters.push(eq(agentRuns.id, run_id))
  const where = filters.length === 1 ? filters[0]! : and(...filters)!

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
      error: agentRuns.error,
      rating: agentDecisions.rating,
      confidence: agentDecisions.confidence,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(where)
    .orderBy(desc(agentRuns.startedAt))
    .limit(50)

  return { rows }
})
