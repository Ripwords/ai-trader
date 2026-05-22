import { defineEventHandler, readBody, createError } from 'h3'
import { and, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'
import { resolveSymbol } from '../../lib/yahoo'
import { AgentRunTee } from '../../utils/agents-tee'
import type { AgentEvent } from '../../../types/agents'

interface AgentsRunBody {
  symbol: string
  max_debate_rounds?: number
  max_risk_discuss_rounds?: number
  deep_thinking?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  response_language?: 'en-US' | 'zh-TW' | 'zh-CN' | 'ja-JP' | 'ko-KR' | 'de-DE'
  selected_analysts?: string[]
  trade_date?: string
}

// A 'running' row older than this is treated as defunct (process died mid-run
// without writing run-end / failed). New runs are allowed past the cutoff so
// a crash doesn't permanently lock out a symbol.
const STALE_RUN_CUTOFF_MIN = 15

export default defineEventHandler(async (event) => {
  const userId = await getOwnerId()
  const body = await readBody<AgentsRunBody>(event)
  if (!body?.symbol) throw createError({ statusCode: 400, statusMessage: 'symbol required' })

  // Hard gate: never run on a raw, unresolved symbol. Resolve to a canonical
  // Yahoo listing first so the agents can't hallucinate the company (the
  // "US.MU" → "Munich Re" bug). Defense in depth — the UI also gates this,
  // but a direct POST or a stale deep link must not slip past.
  // See docs/superpowers/specs/2026-05-18-canonical-ticker-resolution-design.md.
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

  // Reject if a run is already in-flight for (user, symbol). Stale rows older
  // than STALE_RUN_CUTOFF_MIN are ignored so a crashed run doesn't lock the
  // symbol forever — they'll be GC'd by the next successful run's tee, or by
  // an explicit DELETE.
  const cutoff = new Date(Date.now() - STALE_RUN_CUTOFF_MIN * 60_000)
  const inflight = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.symbol, symbol),
        eq(agentRuns.status, 'running'),
        gte(agentRuns.startedAt, cutoff),
      ),
    )
    .limit(1)
  if (inflight[0]) {
    throw createError({
      statusCode: 409,
      statusMessage: 'a run is already in progress for this symbol',
      data: { run_id: inflight[0].id },
    })
  }
  // Best-effort: reap any rows that ARE past the cutoff so the table doesn't
  // accumulate zombie 'running' entries. Don't block on this.
  await db
    .update(agentRuns)
    .set({ status: 'failed', error: 'stale (no run-end before cutoff)', finishedAt: new Date() })
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.symbol, symbol),
        eq(agentRuns.status, 'running'),
        sql`${agentRuns.startedAt} < ${cutoff}`,
      ),
    )

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
        selected_analysts: body.selected_analysts ?? [
          'market', 'social', 'news', 'fundamentals',
        ],
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
      selected_analysts: body.selected_analysts ?? [
        'market', 'social', 'news', 'fundamentals',
      ],
      // Forward the run_id we just minted so the api emits its run-start
      // event with the same uuid the agent_runs row uses. Without this the
      // api would generate its own id; the browser would persist that in
      // ?run=<id>, and a refresh would 404 on agent_runs lookup because the
      // tee writes against our id, not the api's.
      run_id: run.id,
    }),
  })

  if (!upstream.ok || !upstream.body) {
    await db
      .update(agentRuns)
      .set({ status: 'failed', error: `upstream ${upstream.status}` })
      .where(eq(agentRuns.id, run.id))
    throw createError({ statusCode: 502, statusMessage: 'upstream agents service failed' })
  }

  const tee = new AgentRunTee(run.id, userId)
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let teeBuf = ''
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read()
      if (done) {
        // Flush any trailing line into the tee.
        const trimmed = teeBuf.trim()
        if (trimmed) {
          try {
            tee.push(JSON.parse(trimmed) as AgentEvent)
          } catch {
            /* skip malformed */
          }
        }
        controller.close()
        return
      }
      controller.enqueue(value)
      teeBuf += decoder.decode(value, { stream: true })
      const lines = teeBuf.split('\n')
      teeBuf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          tee.push(JSON.parse(trimmed) as AgentEvent)
        } catch {
          /* skip malformed */
        }
      }
    },
    cancel() {
      void reader.cancel()
    },
  })

  event.node.res.setHeader('content-type', 'application/x-ndjson')
  event.node.res.setHeader('cache-control', 'no-store')
  return stream
})
