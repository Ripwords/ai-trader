import { describe, expect, it, vi } from 'vitest'
import { createFakeDb } from './support/fake-db'

const fake = createFakeDb()
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))
vi.mock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
vi.mock('../../server/lib/yahoo', () => ({ resolveSymbol: vi.fn() }))

const { failInterruptedRuns } = await import('../../server/lib/agents/start-run')

describe('failInterruptedRuns', () => {
  it('fails every running run, since their drains died with the previous process', async () => {
    await failInterruptedRuns()

    expect(fake.updates).toHaveLength(1)
    const [u] = fake.updates
    expect(u!.table).toBe('agent_runs')
    expect(u!.set).toMatchObject({ status: 'failed', error: 'interrupted by a web server restart' })
    expect(u!.where).toBe('"agent_runs"."status" = $1')
    expect(u!.params).toEqual(['running'])
  })
})
