import { and, asc, eq, gt } from 'drizzle-orm'
import { getDb } from '../../../db/client'
import { agentMessages, agentRuns } from '../../../db/schema'
import type { AgentEvent, RunStatus } from '../../../types/agents'

export type TerminalStatus = Exclude<RunStatus, 'running'>

export type RunFrame =
  | { kind: 'event'; seq: number; event: AgentEvent }
  | { kind: 'end'; status: TerminalStatus; error: string | null }

const BATCH = 500

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Replay a run's persisted events after `afterSeq`, then follow new ones
 * until the run is terminal. The drain writes events to agent_messages, so
 * any number of readers (SSE clients, the chat tool) can follow one run
 * without holding the api connection.
 */
export async function* tailRun(
  runId: string,
  opts: { afterSeq?: number; pollMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<RunFrame> {
  const { pollMs = 1000, signal } = opts
  let after = opts.afterSeq ?? -1
  const db = getDb()

  while (!signal?.aborted) {
    // Status before rows: the tee writes an event row before the status it
    // implies, so a terminal status here means the rows read next are final.
    const [run] = await db
      .select({ status: agentRuns.status, error: agentRuns.error })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1)
    if (!run) {
      yield { kind: 'end', status: 'failed', error: 'run not found' }
      return
    }

    let rows: Array<{ seq: number; payload: unknown }>
    do {
      rows = await db
        .select({ seq: agentMessages.seq, payload: agentMessages.payload })
        .from(agentMessages)
        .where(and(eq(agentMessages.runId, runId), gt(agentMessages.seq, after)))
        .orderBy(asc(agentMessages.seq))
        .limit(BATCH)
      for (const r of rows) {
        after = r.seq
        yield { kind: 'event', seq: r.seq, event: r.payload as AgentEvent }
      }
    } while (rows.length === BATCH)

    if (run.status !== 'running') {
      yield { kind: 'end', status: run.status as TerminalStatus, error: run.error }
      return
    }
    await sleep(pollMs, signal)
  }
}
