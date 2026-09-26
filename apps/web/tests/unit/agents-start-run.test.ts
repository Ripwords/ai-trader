import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDbOptions } from './support/fake-db'

let fake = createFakeDb()
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))
vi.mock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: async () => ({ status: 'resolved', symbol: 'US.NVDA', name: 'NVIDIA' }),
}))

const { startAgentRun } = await import('../../server/lib/agents/start-run')

const inserted = { id: 'run-new', symbol: 'US.NVDA' }

function setup(runningRows: unknown[], opts: FakeDbOptions = {}) {
  fake = createFakeDb(
    table => table === 'agent_runs' ? runningRows : [],
    { insertReturning: () => [inserted], ...opts },
  )
}

beforeEach(() => {
  setup([])
})

describe('startAgentRun', () => {
  it('fails the inserted run when the agents service is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    }))

    await expect(startAgentRun({ symbol: 'NVDA' })).rejects.toMatchObject({ statusCode: 502 })

    const failed = fake.updates.find(u => u.table === 'agent_runs' && u.set.status === 'failed')
    expect(failed?.set.error).toMatch(/unreachable/)
    expect(failed?.set.finishedAt).toBeInstanceOf(Date)
    expect(failed?.params).toContain('run-new')
  })
})
