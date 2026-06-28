import { and, desc, eq, ne } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns, agentDecisions, agentReflections } from '../../../db/schema'

export interface ThesisRun { runId: string; rating: string | null; confidence: number | null; finishedAt: string | null }
export interface ThesisSummary {
  symbol: string
  latest: ThesisRun | null
  history: ThesisRun[]
  confidenceTrend: 'up' | 'down' | 'flat' | 'n/a'
  staleness: 'fresh' | 'stale' | 'none'
  realizedAlpha: number | null
}

const STALE_DAYS = 21

/** Pure summary from newest-first runs. */
export function summarizeThesis(symbol: string, runs: ThesisRun[], reflectionAlpha: number | null, now: number): ThesisSummary {
  if (runs.length === 0) {
    return { symbol, latest: null, history: [], confidenceTrend: 'n/a', staleness: 'none', realizedAlpha: reflectionAlpha }
  }
  const latest = runs[0]!
  const withConf = runs.filter(r => r.confidence != null)
  let confidenceTrend: ThesisSummary['confidenceTrend'] = 'n/a'
  if (withConf.length >= 2) {
    const diff = (withConf[0]!.confidence ?? 0) - (withConf[1]!.confidence ?? 0)
    confidenceTrend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'
  }
  let staleness: ThesisSummary['staleness'] = 'fresh'
  if (latest.finishedAt) {
    const ageDays = (now - Date.parse(latest.finishedAt)) / 86_400_000
    if (ageDays > STALE_DAYS) staleness = 'stale'
  }
  return { symbol, latest, history: runs, confidenceTrend, staleness, realizedAlpha: reflectionAlpha }
}

export async function buildThesisSummary(userId: string, symbol: string): Promise<ThesisSummary> {
  const db = getDb()
  const rows = await db
    .select({
      runId: agentRuns.id, status: agentRuns.status, finishedAt: agentRuns.finishedAt,
      rating: agentDecisions.rating, confidence: agentDecisions.confidence,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.symbol, symbol), ne(agentRuns.status, 'running')))
    .orderBy(desc(agentRuns.startedAt))
    .limit(20)

  const runs: ThesisRun[] = rows
    .filter(r => r.status !== 'running')
    .map(r => ({ runId: r.runId, rating: r.rating, confidence: r.confidence, finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null }))

  // Realized alpha from the most recent 'overall' reflection for this symbol's latest decided run, if any.
  let alpha: number | null = null
  if (runs[0]) {
    const decRows = await db.select({ id: agentDecisions.id }).from(agentDecisions)
      .where(eq(agentDecisions.runId, runs[0].runId)).limit(1)
    const decId = decRows[0]?.id
    if (decId) {
      const refl = await db.select({ alpha: agentReflections.alpha }).from(agentReflections)
        .where(and(eq(agentReflections.decisionId, decId), eq(agentReflections.role, 'overall'))).limit(1)
      const raw = refl[0]?.alpha
      alpha = raw != null ? Number(raw) : null
    }
  }
  return summarizeThesis(symbol, runs, alpha, Date.now())
}
