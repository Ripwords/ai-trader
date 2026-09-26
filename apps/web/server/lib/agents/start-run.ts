import { and, eq } from 'drizzle-orm'
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

/**
 * Resolve + concurrency-gate + insert the agent_runs row + open the upstream
 * FastAPI NDJSON stream. Throws createError on every failure path
 * (400/409/422/502).
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

  const inflight = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(
      eq(agentRuns.userId, userId),
      eq(agentRuns.symbol, symbol),
      eq(agentRuns.status, 'running'),
    ))
    .limit(1)
  if (inflight[0]) {
    throw createError({
      statusCode: 409,
      statusMessage: 'a run is already in progress for this symbol',
      data: { run_id: inflight[0].id },
    })
  }
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
    // finishedAt is what the active-runs poller keys "recently finished" on;
    // without it a failed start vanished from the UI instead of showing.
    await db.update(agentRuns)
      .set({ status: 'failed', error: `upstream ${upstream.status}`, finishedAt: new Date() })
      .where(eq(agentRuns.id, run.id))
    throw createError({ statusCode: 502, statusMessage: 'upstream agents service failed' })
  }

  return { run, userId, upstream }
}

// The api heartbeats every 15 s, so this much silence means it is gone.
const UPSTREAM_IDLE_TIMEOUT_MS = 90_000

async function readWithin<T>(reader: ReadableStreamDefaultReader<T>, ms: number): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no data from the agents service for ${Math.round(ms / 1000)}s`)), ms)
  })
  try {
    return await Promise.race([reader.read(), idle])
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * Consume the upstream NDJSON stream entirely into a fresh AgentRunTee. Callers
 * start it with ``void`` so it outlives the HTTP request; the app is a
 * long-lived Node process, and this reader keeps the api from seeing a client
 * disconnect. Every exit writes a terminal state: the tee handles run-end and
 * error events, and any other ending records an error event itself.
 */
export async function drainIntoTee(
  upstream: Response,
  runId: string,
  userId: string,
  opts: { idleTimeoutMs?: number; startSeq?: number } = {},
): Promise<void> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS
  const tee = new AgentRunTee(runId, userId, opts.startSeq)
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let finalizeReason: string | null = 'stream ended without terminal event'
  try {
    while (true) {
      const { value, done } = await readWithin(reader, idleTimeoutMs)
      if (done) break
      const { events, rest } = splitNdjson(buf, decoder.decode(value, { stream: true }))
      buf = rest
      for (const ev of events) {
        if (ev.type === 'run-end' || ev.type === 'error') finalizeReason = null
        tee.push(ev)
      }
    }
    const tail = splitNdjson(buf, '\n')
    for (const ev of tail.events) {
      if (ev.type === 'run-end' || ev.type === 'error') finalizeReason = null
      tee.push(ev)
    }
  } catch (e: unknown) {
    console.error('[agents-async] drain failed', (e as Error)?.message)
    finalizeReason = e instanceof Error ? e.message : String(e)
    void reader.cancel().catch(() => {})
  } finally {
    if (finalizeReason !== null) tee.push({ type: 'error', message: finalizeReason })
    await tee.flush()
  }
}

/** A drain lives in the web process, so a restart orphans every running run. */
export async function failInterruptedRuns(): Promise<void> {
  await getDb().update(agentRuns)
    .set({ status: 'failed', finishedAt: new Date(), error: 'interrupted by a web server restart' })
    .where(eq(agentRuns.status, 'running'))
}
