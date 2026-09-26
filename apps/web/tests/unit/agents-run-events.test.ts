import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from './support/fake-db'

let fake = createFakeDb()
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))

const { tailRun } = await import('../../server/lib/agents/run-events')

interface Script {
  statuses: Array<{ status: string; error?: string | null }>
  batches: Array<Array<{ seq: number; payload: unknown }>>
}

function scripted(script: Script) {
  const reads: string[] = []
  fake = createFakeDb((table) => {
    reads.push(table)
    if (table === 'agent_runs') {
      const s = script.statuses.length > 1 ? script.statuses.shift()! : script.statuses[0]!
      return [{ status: s.status, error: s.error ?? null }]
    }
    return script.batches.shift() ?? []
  })
  return reads
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const f of gen) out.push(f)
  return out
}

beforeEach(() => {
  fake = createFakeDb()
})

describe('tailRun', () => {
  it('replays persisted events, tails new ones, and ends once the run is terminal', async () => {
    const reads = scripted({
      statuses: [{ status: 'running' }, { status: 'complete' }],
      batches: [
        [{ seq: 3, payload: { type: 'node-start', node: 'market' } }],
        [{ seq: 4, payload: { type: 'run-end', run_id: 'r', tokens_in: 1, tokens_out: 1, cost_usd: 0 } }],
      ],
    })

    const frames = await collect(tailRun('run-1', { afterSeq: 2, pollMs: 1 }))

    expect(frames).toEqual([
      { kind: 'event', seq: 3, event: { type: 'node-start', node: 'market' } },
      { kind: 'event', seq: 4, event: { type: 'run-end', run_id: 'r', tokens_in: 1, tokens_out: 1, cost_usd: 0 } },
      { kind: 'end', status: 'complete', error: null },
    ])
    // Status is read before rows each tick, so the rows of the tick that sees
    // a terminal status include everything written before the flip.
    expect(reads).toEqual(['agent_runs', 'agent_messages', 'agent_runs', 'agent_messages'])
  })

  it('ends with the stored error when the run failed without an error event', async () => {
    scripted({ statuses: [{ status: 'failed', error: 'interrupted by a web restart' }], batches: [] })

    const frames = await collect(tailRun('run-1', { pollMs: 1 }))

    expect(frames).toEqual([{ kind: 'end', status: 'failed', error: 'interrupted by a web restart' }])
  })

  it('ends as failed when the run does not exist', async () => {
    fake = createFakeDb(() => [])

    const frames = await collect(tailRun('missing', { pollMs: 1 }))

    expect(frames).toEqual([{ kind: 'end', status: 'failed', error: 'run not found' }])
  })

  it('stops when the signal aborts', async () => {
    scripted({ statuses: [{ status: 'running' }], batches: [] })
    const ac = new AbortController()
    const gen = tailRun('run-1', { pollMs: 5, signal: ac.signal })
    setTimeout(() => ac.abort(), 20)

    expect(await collect(gen)).toEqual([])
  })
})
