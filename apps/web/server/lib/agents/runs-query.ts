import { and, desc, eq, gte, inArray, max, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../../db/client'
import { agentRuns, agentDecisions, agentMessages, valuationSnapshots } from '../../../db/schema'
import { buildRunVerdict, type RunVerdictResult } from './verdict'

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
  /** The rating the agents reached, when the valuation veto capped it to `rating`. */
  originalRating: string | null
}
export interface RunAssessment extends LatestRunSummary { rationale: string | null }

interface RunDecisionRow {
  id: string; symbol: string; status: string; finishedAt: Date | null
  rating: string | null; confidence: number | null; originalRating: string | null
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
    originalRating: row.originalRating,
  }
}

const MARKET_PREFIX = /^(US|HK|SH|SZ|SG|JP|AU|MY|CA)\.(.+)$/

/**
 * Runs are stored under the resolved symbol, usually moomoo's `US.AMZN`,
 * while callers pass what the user or the model wrote. `AMZN` finds a run
 * under any market prefix; `US.AMZN` finds `AMZN` too, but never `HK.AMZN`.
 */
function storedSymbolIs(requested: string) {
  const upper = requested.trim().toUpperCase()
  const prefixed = MARKET_PREFIX.exec(upper)
  const ticker = (prefixed?.[2] ?? upper).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return sql`${agentRuns.symbol} ~ ${`^(${prefixed?.[1] ?? '[A-Z]{2}'}\\.)?${ticker}$`}`
}

const originalRating = sql<string | null>`(
  select m.payload->>'original_rating' from ${agentMessages} m
  where m.run_id = ${agentRuns.id} and m.kind = 'valuation-veto'
  order by m.seq desc limit 1
)`

/**
 * The run to cite for (user, symbol): the latest complete one, so a newer
 * failed or cancelled attempt does not hide a verdict. With no complete run,
 * the latest finished attempt. Null when the symbol has only running runs or none.
 */
export async function getLatestRunForSymbol(userId: string, symbol: string): Promise<LatestRunSummary | null> {
  const db = getDb()
  const rows = await db
    .select({
      id: agentRuns.id, symbol: agentRuns.symbol, status: agentRuns.status,
      finishedAt: agentRuns.finishedAt, rating: agentDecisions.rating, confidence: agentDecisions.confidence,
      originalRating,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(and(eq(agentRuns.userId, userId), storedSymbolIs(symbol), ne(agentRuns.status, 'running')))
    .orderBy(desc(sql`${agentRuns.status} = 'complete'`), desc(agentRuns.startedAt))
    .limit(1)
  return rows[0] ? summarizeRunRow(rows[0]) : null
}

export interface RunAttempt { runId: string; status: string; error: string | null; startedAt: string }

/** The newest run for (user, symbol) whatever its status, running and failed included. */
export async function getLatestAttemptForSymbol(userId: string, symbol: string): Promise<RunAttempt | null> {
  const rows = await getDb()
    .select({ runId: agentRuns.id, status: agentRuns.status, error: agentRuns.error, startedAt: agentRuns.startedAt })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), storedSymbolIs(symbol)))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1)
  return rows[0] ? { ...rows[0], startedAt: rows[0].startedAt.toISOString() } : null
}

export interface ResearchedSymbol { symbol: string; companyName: string | null }

/** Every symbol the user has a finished run for. */
export async function listResearchedSymbols(userId: string): Promise<ResearchedSymbol[]> {
  return getDb()
    .select({ symbol: agentRuns.symbol, companyName: max(sql<string>`${agentRuns.config}->>'company_name'`) })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), ne(agentRuns.status, 'running')))
    .groupBy(agentRuns.symbol)
}

/** Full assessment for a runId (owner-scoped). Null if missing or not owned. */
export async function getRunAssessment(userId: string, runId: string): Promise<RunAssessment | null> {
  const db = getDb()
  const rows = await db
    .select({
      id: agentRuns.id, symbol: agentRuns.symbol, status: agentRuns.status, userId: agentRuns.userId,
      finishedAt: agentRuns.finishedAt,
      rating: agentDecisions.rating, confidence: agentDecisions.confidence, rationale: agentDecisions.rationale,
      originalRating,
    })
    .from(agentRuns)
    .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .limit(1)
  const row = rows[0]
  if (!row || row.userId !== userId) return null
  return { ...summarizeRunRow(row), rationale: row.rationale }
}

const VetoEvent = z.object({ original_rating: z.string(), reason: z.string() })
const ValuationEvent = z.object({ status: z.literal('unavailable'), reason: z.string() })
const DecisionEvent = z.object({ owner_verdict: z.enum(['add', 'hold', 'trim', 'do-not-add']) })

const stateText = (...path: string[]) =>
  sql<string | null>`${agentRuns.finalState} #>> ${`{${path.join(',')}}`}`

const numberOrNull = (value: string | null) => (value === null ? null : Number(value))

/**
 * The chat's verdict for a run (owner-scoped; null if missing or not owned).
 * `final_state` runs to ~100 KB, so only the debate texts are read from it.
 */
export async function getRunVerdict(userId: string, runId: string, nowMs = Date.now()): Promise<RunVerdictResult | null> {
  const db = getDb()
  const [runs, events, valuations] = await Promise.all([
    db
      .select({
        symbol: agentRuns.symbol, status: agentRuns.status, error: agentRuns.error, finishedAt: agentRuns.finishedAt,
        rating: agentDecisions.rating, confidence: agentDecisions.confidence, rationale: agentDecisions.rationale,
        bull: stateText('investment_debate_state', 'bull_history'),
        bear: stateText('investment_debate_state', 'bear_history'),
        aggressive: stateText('risk_debate_state', 'aggressive_history'),
        conservative: stateText('risk_debate_state', 'conservative_history'),
        neutral: stateText('risk_debate_state', 'neutral_history'),
        researchManager: stateText('investment_plan'),
      })
      .from(agentRuns)
      .leftJoin(agentDecisions, eq(agentDecisions.runId, agentRuns.id))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1),
    db
      .select({ kind: agentMessages.kind, payload: agentMessages.payload })
      .from(agentMessages)
      .where(and(eq(agentMessages.runId, runId), inArray(agentMessages.kind, ['valuation-veto', 'valuation', 'decision'])))
      .orderBy(desc(agentMessages.seq)),
    db
      .select({
        fairValue: valuationSnapshots.fairValue, currentPrice: valuationSnapshots.currentPrice,
        marginOfSafetyPct: valuationSnapshots.marginOfSafetyPct, dataQuality: valuationSnapshots.dataQuality,
        currency: sql<string | null>`${valuationSnapshots.result}->>'currency'`,
        discardedReason: sql<string | null>`${valuationSnapshots.result}->>'dcf_invalid_reason'`,
      })
      .from(valuationSnapshots)
      .where(eq(valuationSnapshots.runId, runId))
      .orderBy(desc(valuationSnapshots.createdAt))
      .limit(1),
  ])
  const run = runs[0]
  if (!run) return null

  const veto = VetoEvent.safeParse(events.find(e => e.kind === 'valuation-veto')?.payload)
  const unavailable = ValuationEvent.safeParse(events.find(e => e.kind === 'valuation')?.payload)
  const owner = DecisionEvent.safeParse(events.find(e => e.kind === 'decision')?.payload)
  const valuation = valuations[0]
  return buildRunVerdict({
    runId,
    symbol: run.symbol,
    status: run.status,
    error: run.error,
    finishedAt: run.finishedAt,
    decision: run.rating === null || run.rationale === null
      ? null
      : {
          rating: run.rating, confidence: run.confidence, rationale: run.rationale,
          ownerVerdict: owner.success ? owner.data.owner_verdict : null,
        },
    cap: veto.success ? { originalRating: veto.data.original_rating, reason: veto.data.reason } : null,
    valuation: valuation
      ? {
          ...valuation,
          fairValue: numberOrNull(valuation.fairValue),
          currentPrice: numberOrNull(valuation.currentPrice),
          marginOfSafetyPct: numberOrNull(valuation.marginOfSafetyPct),
        }
      : null,
    valuationUnavailableReason: unavailable.success ? unavailable.data.reason : null,
    debate: {
      bull: run.bull, bear: run.bear,
      aggressive: run.aggressive, conservative: run.conservative, neutral: run.neutral,
      researchManager: run.researchManager,
    },
  }, nowMs)
}
