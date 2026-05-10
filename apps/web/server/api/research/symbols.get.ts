import { defineEventHandler } from 'h3'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns, agentDecisions } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'

/**
 * GET /api/research/symbols
 *
 * Per-symbol aggregate of the caller's agent_runs history. Powers the
 * /research index page's "tickers I've researched" tile grid.
 *
 * One row per distinct ``symbol``. Aggregates we care about:
 *   - ``runCount``: total runs (any status)
 *   - ``completeCount``: how many made it to ``complete``
 *   - ``hasInflight``: any row currently ``status='running'``
 *   - ``latestStartedAt``: timestamp of the most recent run
 *   - ``latestRating`` / ``latestConfidence``: from the matching
 *     ``agent_decisions`` row of the latest *complete* run, so the
 *     tile can show "BUY 72%" at a glance. Null if no run completed.
 *
 * Owner-scoped via ``getOwnerId()``; sessionless callers (api container)
 * never reach here because the auth middleware short-circuits.
 */
export default defineEventHandler(async () => {
  const userId = await getOwnerId()
  const db = getDb()

  // Two queries beats one giant correlated subquery for readability.
  // 1) The base aggregate (per-symbol counts + flags).
  // 2) The latest *completed* decision per symbol (for the rating chip).
  // Joined on the JS side because Drizzle's lateral-join ergonomics are
  // gnarly and the row count is tiny (one per researched symbol).
  const aggregates = await db
    .select({
      symbol: agentRuns.symbol,
      runCount: sql<number>`COUNT(*)::int`.as('run_count'),
      completeCount: sql<number>`COUNT(*) FILTER (WHERE ${agentRuns.status} = 'complete')::int`.as('complete_count'),
      hasInflight: sql<boolean>`BOOL_OR(${agentRuns.status} = 'running')`.as('has_inflight'),
      latestStartedAt: sql<string>`MAX(${agentRuns.startedAt})`.as('latest_started_at'),
    })
    .from(agentRuns)
    .where(eq(agentRuns.userId, userId))
    .groupBy(agentRuns.symbol)
    .orderBy(sql`MAX(${agentRuns.startedAt}) DESC`)

  // Latest *completed* decision per symbol — DISTINCT ON pulls the most
  // recent row for each ``symbol`` ordered by ``created_at DESC``. Only
  // looks at completed runs since a failed/cancelled run has a row in
  // agent_decisions only if it limped past the trader.
  const latest = await db.execute(sql`
    SELECT DISTINCT ON (d.symbol)
      d.symbol,
      d.rating,
      d.confidence,
      d.created_at AS decided_at
    FROM ${agentDecisions} d
    JOIN ${agentRuns} r ON r.id = d.run_id
    WHERE d.user_id = ${userId}
      AND r.status = 'complete'
    ORDER BY d.symbol, d.created_at DESC
  `)
  const latestBySymbol = new Map<string, { rating: string; confidence: number; decided_at: string }>()
  for (const row of latest.rows ?? latest as unknown as Array<{ symbol: string; rating: string; confidence: number; decided_at: string }>) {
    const r = row as { symbol: string; rating: string; confidence: number; decided_at: string }
    latestBySymbol.set(r.symbol, {
      rating: r.rating,
      confidence: Number(r.confidence),
      decided_at: r.decided_at,
    })
  }

  return {
    symbols: aggregates.map((a) => {
      const decision = latestBySymbol.get(a.symbol) ?? null
      return {
        symbol: a.symbol,
        runCount: a.runCount,
        completeCount: a.completeCount,
        hasInflight: a.hasInflight,
        latestStartedAt: a.latestStartedAt,
        latestRating: decision?.rating ?? null,
        latestConfidence: decision?.confidence ?? null,
      }
    }),
  }
})
