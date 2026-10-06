import { and, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { agentRuns, agentMessages, agentDecisions } from '../../db/schema'
import type { AgentEvent } from '../../types/agents'
import { notifyRun } from '../lib/agents/run-signal'

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
  private errorMessage: string | null = null
  private ended = false

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

  /** Resolves once every pushed event has been written. */
  flush(): Promise<void> {
    return this.drained
  }

  /**
   * Readers treat a terminal status as "every row is written", so the status
   * lands only after the api's last row (run-end) or, when the stream ends
   * without one, here. `reason` becomes the error event of a stream that
   * ended with neither.
   */
  async end(reason: string): Promise<void> {
    await this.flush()
    if (this.ended) return
    if (this.errorMessage === null) {
      this.push({ type: 'error', message: reason })
      await this.flush()
    }
    await this.writeTerminal().catch((e: unknown) => {
      console.error('[agents-tee] status write failed', (e as Error)?.message)
    })
  }

  private async writeTerminal() {
    this.ended = true
    const msg = this.errorMessage
    // The api reports a cancelled task as this exact error.
    const status = msg === null ? 'complete' : msg === 'cancelled' ? 'cancelled' : 'failed'
    try {
      await getDb()
        .update(agentRuns)
        .set({ status, finishedAt: new Date(), error: msg })
        .where(and(eq(agentRuns.id, this.runId), eq(agentRuns.status, 'running')))
    }
    finally {
      notifyRun(this.runId, { final: true })
    }
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
        notifyRun(this.runId)
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
                confidence: ev.confidence,
                rationale: ev.rationale,
              })
            }
          }
          if (ev.type === 'error') this.errorMessage ??= ev.message
          if (ev.type === 'run-end') {
            await db
              .update(agentRuns)
              .set({ tokensIn: ev.tokens_in, tokensOut: ev.tokens_out, costUsd: ev.cost_usd.toString() })
              .where(eq(agentRuns.id, this.runId))
            await this.writeTerminal()
          }
          if (ev.type === 'final-state') {
            // Persist the captured terminal AgentState (analyst reports,
            // debate histories, plans) as the run's audit record.
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
