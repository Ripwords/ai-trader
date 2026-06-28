import { and, eq, gte, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { getDb } from '../../../db/client'
import { agentRuns } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'
import { resolveSymbol } from '../../lib/yahoo'
import { AgentRunTee } from '../../utils/agents-tee'
import { splitNdjson } from '../../utils/ndjson'

export interface AgentsRunBody {
  symbol: string
  max_debate_rounds?: number
  max_risk_discuss_rounds?: number
  deep_thinking?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  response_language?: 'en-US' | 'zh-TW' | 'zh-CN' | 'ja-JP' | 'ko-KR' | 'de-DE'
  selected_analysts?: string[]
  trade_date?: string
}

export interface StartedRun {
  run: typeof agentRuns.$inferSelect
  userId: string
  upstream: Response
}

const STALE_RUN_CUTOFF_MIN = 15

/**
 * Resolve + concurrency-gate + insert the agent_runs row + open the upstream
 * FastAPI NDJSON stream. Shared by the inline streaming endpoint
 * (agents-run.post.ts) and the fire-and-forget endpoint
 * (agents-run-async.post.ts). Throws createError on every failure path so both
 * callers get identical status codes (400/409/422/502).
 */
export async function startAgentRun(body: AgentsRunBody): Promise<StartedRun> {
  const userId = await getOwnerId()
  if (!body?.symbol) throw createError({ statusCode: 400, statusMessage: 'symbol required' })

  const resolution = await resolveSymbol(body.symbol)
  if (resolution.status !== 'resolved') {
    throw createError({
      statusCode: 422,
      statusMessage: 'symbol could not be uniquely resolved — pick from search',
      data: resolution,
    })
  }
  const symbol = resolution.symbol
  const companyName = resolution.name
  const tradeDate = body.trade_date ?? new Date().toISOString().slice(0, 10)
  const db = getDb()

  const cutoff = new Date(Date.now() - STALE_RUN_CUTOFF_MIN * 60_000)
  const inflight = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.userId, userId),
      eq(agentRuns.symbol, symbol),
      eq(agentRuns.status, 'running'),
      gte(agentRuns.startedAt, cutoff),
    ))
    .limit(1)
  if (inflight[0]) {
    throw createError({
      statusCode: 409,
      statusMessage: 'a run is already in progress for this symbol',
      data: { run_id: inflight[0].id },
    })
  }
  await db
    .update(agentRuns)
    .set({ status: 'failed', error: 'stale (no run-end before cutoff)', finishedAt: new Date() })
    .where(and(
      eq(agentRuns.userId, userId),
      eq(agentRuns.symbol, symbol),
      eq(agentRuns.status, 'running'),
      sql`${agentRuns.startedAt} < ${cutoff}`,
    ))

  const inserted = await db
    .insert(agentRuns)
    .values({
      userId,
      symbol,
      tradeDate,
      status: 'running',
      config: {
        company_name: companyName,
        max_debate_rounds: body.max_debate_rounds ?? 1,
        max_risk_discuss_rounds: body.max_risk_discuss_rounds ?? 1,
        deep_thinking: body.deep_thinking ?? true,
        reasoning_effort: body.reasoning_effort ?? 'medium',
        response_language: body.response_language ?? 'en-US',
        selected_analysts: body.selected_analysts ?? ['market', 'social', 'news', 'fundamentals'],
      },
    })
    .returning()
  const run = inserted[0]!

  const apiBase = process.env.NUXT_API_BASE_URL ?? 'http://api:8000'
  const internalBearer = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER ?? ''
  const upstream = await fetch(`${apiBase}/agents/run`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${internalBearer}`,
      'content-type': 'application/json',
      'x-user-id': userId,
    },
    body: JSON.stringify({
      symbol,
      company_name: companyName,
      trade_date: tradeDate,
      max_debate_rounds: body.max_debate_rounds ?? 1,
      max_risk_discuss_rounds: body.max_risk_discuss_rounds ?? 1,
      deep_thinking: body.deep_thinking ?? true,
      reasoning_effort: body.reasoning_effort ?? 'medium',
      response_language: body.response_language ?? 'en-US',
      selected_analysts: body.selected_analysts ?? ['market', 'social', 'news', 'fundamentals'],
      run_id: run.id,
    }),
  })

  if (!upstream.ok || !upstream.body) {
    await db.update(agentRuns).set({ status: 'failed', error: `upstream ${upstream.status}` }).where(eq(agentRuns.id, run.id))
    throw createError({ statusCode: 502, statusMessage: 'upstream agents service failed' })
  }

  return { run, userId, upstream }
}

/**
 * Consume the upstream NDJSON stream entirely into a fresh AgentRunTee. Used by
 * the fire-and-forget endpoint: it is started with ``void`` so it outlives the
 * HTTP response. Safe because the app runs under a long-lived Node process
 * (Docker, not serverless); the server-side reader keeps the stream alive so
 * the api's client-disconnect kill does not trigger. The tee finalizes the
 * agent_runs row (complete/failed) exactly as the inline path does.
 */
export async function drainIntoTee(upstream: Response, runId: string, userId: string): Promise<void> {
  const tee = new AgentRunTee(runId, userId)
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const { events, rest } = splitNdjson(buf, decoder.decode(value, { stream: true }))
      buf = rest
      for (const ev of events) tee.push(ev)
    }
    const tail = splitNdjson(buf, '\n')
    for (const ev of tail.events) tee.push(ev)
  } catch (e: unknown) {
    console.error('[agents-async] drain failed', (e as Error)?.message)
  }
}
