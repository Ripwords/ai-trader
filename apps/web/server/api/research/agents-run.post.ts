import { defineEventHandler, readBody, createError } from 'h3'
import { eq } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentRuns } from '../../../db/schema'
import { getOwnerId } from '../../db/repo'
import { AgentRunTee } from '../../utils/agents-tee'
import type { AgentEvent } from '../../../types/agents'

interface AgentsRunBody {
  symbol: string
  max_debate_rounds?: number
  deep_thinking?: boolean
  trade_date?: string
}

export default defineEventHandler(async (event) => {
  const userId = await getOwnerId()
  const body = await readBody<AgentsRunBody>(event)
  if (!body?.symbol) throw createError({ statusCode: 400, statusMessage: 'symbol required' })

  const tradeDate = body.trade_date ?? new Date().toISOString().slice(0, 10)
  const db = getDb()
  const inserted = await db
    .insert(agentRuns)
    .values({
      userId,
      symbol: body.symbol,
      tradeDate,
      status: 'running',
      config: {
        max_debate_rounds: body.max_debate_rounds ?? 1,
        deep_thinking: body.deep_thinking ?? true,
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
      symbol: body.symbol,
      trade_date: tradeDate,
      max_debate_rounds: body.max_debate_rounds ?? 1,
      deep_thinking: body.deep_thinking ?? true,
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
