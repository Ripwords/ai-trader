import { and, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { agentRuns, agentMessages, agentDecisions } from '../../db/schema'
import type { AgentEvent } from '../../types/agents'

const QUEUE_CAP = 100

/** Events that change agent_runs.status or its terminal payload. Dropping
 *  one leaves the run "running" forever, which 409s every later run on the
 *  same symbol, so they bypass the queue cap. */
const TERMINAL_EVENTS = new Set(['run-end', 'error', 'final-state', 'decision'])

export class AgentRunTee {
  private queue: AgentEvent[] = []
  private seq: number
  private drained: Promise<void> = Promise.resolve()
  private draining = false

  /** `startSeq` continues a resumed run's timeline after its existing rows. */
  constructor(public runId: string, public userId: string, startSeq = 0) {
    this.seq = startSeq
  }

  push(ev: AgentEvent) {
    if (ev.type === 'heartbeat') return
    if (this.queue.length >= QUEUE_CAP && !TERMINAL_EVENTS.has(ev.type)) {
      console.warn('[agents-tee] queue overflow, dropping', ev.type)
      return
    }
    this.queue.push(ev)
    if (!this.draining) this.drained = this.drain()
  }

  /** The api follows an error with run-end, and a cancel precedes both, so
   *  only the first terminal transition may land. */
  private stillRunning() {
    return and(eq(agentRuns.id, this.runId), eq(agentRuns.status, 'running'))
  }

  /** Resolves once every pushed event has been written. */
  flush(): Promise<void> {
    return this.drained
  }

  private async drain() {
    this.draining = true
    const db = getDb()
    try {
      while (this.queue.length) {
        const ev = this.queue.shift()!
        const s = this.seq++
        // The message row is the timeline; the status update is the run's
        // fate. A failed timeline insert must not skip the status update.
        try {
          await db.insert(agentMessages).values({
            runId: this.runId,
            seq: s,
            kind: ev.type,
            node: 'node' in ev ? (ev.node ?? null) : null,
            payload: ev as unknown as Record<string, unknown>,
          })
        } catch (e: unknown) {
          console.error('[agents-tee] message write failed', (e as Error)?.message)
        }
        try {
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
                // ``confidence`` is ``NOT NULL``; the parser sends null when
                // the model gave no number, so persist the neutral 50 default.
                confidence: ev.confidence ?? 50,
                rationale: ev.rationale,
              })
            }
          }
          if (ev.type === 'run-end') {
            await db
              .update(agentRuns)
              .set({ tokensIn: ev.tokens_in, tokensOut: ev.tokens_out, costUsd: ev.cost_usd.toString() })
              .where(eq(agentRuns.id, this.runId))
            await db
              .update(agentRuns)
              .set({ status: 'complete', finishedAt: new Date() })
              .where(this.stillRunning())
          }
          if (ev.type === 'error') {
            // The api reports a cancelled task as this exact error.
            const status = ev.message === 'cancelled' ? 'cancelled' : 'failed'
            await db
              .update(agentRuns)
              .set({ status, finishedAt: new Date(), error: ev.message })
              .where(this.stillRunning())
          }
          if (ev.type === 'final-state') {
            // Persist the captured terminal AgentState so the per-role
            // reflection job can read the four analyst reports + debate
            // histories + plans without re-walking agent_messages.
            await db
              .update(agentRuns)
              .set({ finalState: ev.state })
              .where(eq(agentRuns.id, this.runId))
          }
        } catch (e: unknown) {
          console.error('[agents-tee] status write failed', (e as Error)?.message)
        }
      }
    } finally {
      this.draining = false
    }
  }
}
