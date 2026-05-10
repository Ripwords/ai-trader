import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { agentRuns, agentMessages, agentDecisions } from '../../db/schema'
import type { AgentEvent } from '../../types/agents'

const QUEUE_CAP = 100

export class AgentRunTee {
  private queue: AgentEvent[] = []
  private seq = 0
  private draining = false

  constructor(public runId: string, public userId: string) {}

  push(ev: AgentEvent) {
    if (this.queue.length >= QUEUE_CAP) {
      console.warn('[agents-tee] queue overflow, dropping', ev.type)
      return
    }
    this.queue.push(ev)
    void this.drain()
  }

  private async drain() {
    if (this.draining) return
    this.draining = true
    const db = getDb()
    try {
      while (this.queue.length) {
        const ev = this.queue.shift()!
        const s = this.seq++
        try {
          await db.insert(agentMessages).values({
            runId: this.runId,
            seq: s,
            kind: ev.type,
            node: 'node' in ev ? (ev.node ?? null) : null,
            payload: ev as unknown as Record<string, unknown>,
          })
          if (ev.type === 'decision') {
            const rows = await db
              .select()
              .from(agentRuns)
              .where(eq(agentRuns.id, this.runId))
              .limit(1)
            const run = rows[0]
            if (run) {
              await db.insert(agentDecisions).values({
                runId: this.runId,
                userId: this.userId,
                symbol: run.symbol,
                tradeDate: run.tradeDate,
                rating: ev.rating,
                confidence: ev.confidence,
                rationale: ev.rationale,
              })
            }
          }
          if (ev.type === 'run-end') {
            await db
              .update(agentRuns)
              .set({
                status: 'complete',
                finishedAt: new Date(),
                tokensIn: ev.tokens_in,
                tokensOut: ev.tokens_out,
                costUsd: ev.cost_usd.toString(),
              })
              .where(eq(agentRuns.id, this.runId))
          }
          if (ev.type === 'error') {
            await db
              .update(agentRuns)
              .set({
                status: 'failed',
                finishedAt: new Date(),
                error: ev.message,
              })
              .where(eq(agentRuns.id, this.runId))
          }
        } catch (e: unknown) {
          console.error('[agents-tee] write failed', (e as Error)?.message)
        }
      }
    } finally {
      this.draining = false
    }
  }
}
