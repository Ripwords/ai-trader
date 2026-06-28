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

export interface LatestRunSummary {
  runId: string; symbol: string; status: string; finishedAt: string | null
  rating: string | null; confidence: number | null
}
export interface RunAssessment extends LatestRunSummary { rationale: string | null }

interface RunDecisionRow {
  id: string; symbol: string; status: string; finishedAt: Date | null
  rating: string | null; confidence: number | null
}

/** Pure shaper for a joined run+decision row. */
export function summarizeRunRow(row: RunDecisionRow): LatestRunSummary {
  return {
    runId: row.id,
    symbol: row.symbol,
    status: row.status,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    rating: row.rating,
    confidence: row.confidence,
  }
}

/** Latest non-running run for (user, symbol), or null. Symbol matched case-insensitively-ish by exact stored value. */
export async function getLatestRunForSymbol(userId: string, symbol: string): Promise<LatestRunSummary | null> {
  const db = getDb()
  const rows = await db
    .select({
      id: agentRuns.id, symbol: agentRuns.symbol, status: agentRuns.status,
      finishedAt: agentRuns.finishedAt, rating: agentDecisions.rating, confidence: agentDecisions.confidence,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.symbol, symbol), ne(agentRuns.status, 'running')))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1)
  return rows[0] ? summarizeRunRow(rows[0]) : null
}

/** Full assessment for a runId (owner-scoped). Null if missing or not owned. */
export async function getRunAssessment(userId: string, runId: string): Promise<RunAssessment | null> {
  const db = getDb()
  const rows = await db
    .select({
      id: agentRuns.id, symbol: agentRuns.symbol, status: agentRuns.status, userId: agentRuns.userId,
      finishedAt: agentRuns.finishedAt,
      rating: agentDecisions.rating, confidence: agentDecisions.confidence, rationale: agentDecisions.rationale,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .limit(1)
  const row = rows[0]
  if (!row || row.userId !== userId) return null
  return { ...summarizeRunRow(row), rationale: row.rationale }
}
