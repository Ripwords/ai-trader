import { and, desc, eq, gte, ne } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns, agentDecisions } from '../../../db/schema'

export interface ActiveRun { runId: string; symbol: string; startedAt: string | null }
export interface FinishedRun {
  runId: string
  symbol: string
  status: 'complete' | 'failed' | 'cancelled'
  rating: string | null
  confidence: number | null
}
export interface ActiveRunsResponse { active: ActiveRun[]; recentlyFinished: FinishedRun[] }

interface ActiveRow { id: string; symbol: string; startedAt: Date | null }
interface FinishedRow { id: string; symbol: string; status: string; rating: string | null; confidence: number | null }

/** Pure shaper — DB rows → API response. */
export function shapeActiveRuns(activeRows: ActiveRow[], finishedRows: FinishedRow[]): ActiveRunsResponse {
  return {
    active: activeRows.map(r => ({
      runId: r.id,
      symbol: r.symbol,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    })),
    recentlyFinished: finishedRows.map(r => ({
      runId: r.id,
      symbol: r.symbol,
      status: r.status as FinishedRun['status'],
      rating: r.rating,
      confidence: r.confidence,
    })),
  }
}

export async function getActiveRuns(userId: string, finishedSinceMs: number): Promise<ActiveRunsResponse> {
  const db = getDb()
  const activeRows = await db
    .select({ id: agentRuns.id, symbol: agentRuns.symbol, startedAt: agentRuns.startedAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.status, 'running')))
    .orderBy(desc(agentRuns.startedAt))
    .limit(50)

  const cutoff = new Date(Date.now() - finishedSinceMs)
  const finishedRows = await db
    .select({
      id: agentRuns.id,
      symbol: agentRuns.symbol,
      status: agentRuns.status,
      rating: agentDecisions.rating,
      confidence: agentDecisions.confidence,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(and(
      eq(agentRuns.userId, userId),
      ne(agentRuns.status, 'running'),
      gte(agentRuns.finishedAt, cutoff),
    ))
    .orderBy(desc(agentRuns.finishedAt))
    .limit(50)

  return shapeActiveRuns(activeRows, finishedRows)
}
