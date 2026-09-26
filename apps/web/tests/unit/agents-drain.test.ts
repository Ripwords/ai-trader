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
})
