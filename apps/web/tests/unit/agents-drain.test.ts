import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from './support/fake-db'

let fake = createFakeDb()
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))
vi.mock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
vi.mock('../../server/lib/yahoo', () => ({ resolveSymbol: vi.fn() }))

const { drainIntoTee } = await import('../../server/lib/agents/start-run')

const enc = new TextEncoder()

function upstream(lines: string[], opts: { hang?: boolean } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l + '\n'))
      if (!opts.hang) controller.close()
    },
  })
  return new Response(body)
}

const runStart = '{"type":"run-start","run_id":"run-1","symbol":"NVDA","config":{}}'

beforeEach(() => {
  fake = createFakeDb()
})

describe('drainIntoTee', () => {
  it('fails the run when the upstream goes silent past the idle timeout', async () => {
    await drainIntoTee(upstream([runStart], { hang: true }), 'run-1', 'user-1', { idleTimeoutMs: 30 })

    const failed = fake.updates.find(u => u.table === 'agent_runs' && u.set.status === 'failed')
    expect(failed?.set.error).toMatch(/no data from the agents service/)
  })

  it('treats heartbeats as liveness', async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(enc.encode(runStart + '\n'))
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 15))
          controller.enqueue(enc.encode('{"type":"heartbeat"}\n'))
        }
        controller.enqueue(enc.encode('{"type":"run-end","run_id":"run-1","tokens_in":1,"tokens_out":1,"cost_usd":0}\n'))
        controller.close()
      },
    })
    await drainIntoTee(new Response(body), 'run-1', 'user-1', { idleTimeoutMs: 40 })

    expect(fake.updates.some(u => u.set.status === 'failed')).toBe(false)
    expect(fake.updates.some(u => u.set.status === 'complete')).toBe(true)
  })
  it('records an error event and fails the run when the upstream ends without a terminal event', async () => {
    await drainIntoTee(upstream([runStart]), 'run-1', 'user-1')

    const kinds = fake.inserts.filter(i => i.table === 'agent_messages').map(i => i.values.kind)
    expect(kinds).toEqual(['run-start', 'error'])
    const failed = fake.updates.find(u => u.table === 'agent_runs' && u.set.status === 'failed')
    expect(failed?.set.error).toBe('stream ended without terminal event')
    expect(failed?.params).toContain('running')
  })

  it('records an error event when the upstream read throws', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(runStart + '\n'))
        controller.error(new TypeError('terminated'))
      },
    })
    await drainIntoTee(new Response(body), 'run-1', 'user-1')

    const errors = fake.inserts.filter(i => i.table === 'agent_messages' && i.values.kind === 'error')
    expect(errors.map(e => (e.values.payload as { message: string }).message)).toEqual(['terminated'])
  })
})
