import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from './support/fake-db'

let fake = createFakeDb()
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))

const { AgentRunTee } = await import('../../server/utils/agents-tee')

beforeEach(() => {
  fake = createFakeDb()
})

describe('AgentRunTee', () => {
  it('does not persist transport heartbeats', async () => {
    const tee = new AgentRunTee('run-1', 'user-1')
    tee.push({ type: 'node-start', node: 'market' })
    tee.push({ type: 'heartbeat' })
    tee.push({ type: 'node-end', node: 'market', summary: '' })
    await tee.flush()

    const rows = fake.inserts.filter(i => i.table === 'agent_messages')
    expect(rows.map(r => r.values.kind)).toEqual(['node-start', 'node-end'])
    expect(rows.map(r => r.values.seq)).toEqual([0, 1])
  })
  it('only moves a running run to a terminal status', async () => {
    const tee = new AgentRunTee('run-1', 'user-1')
    tee.push({ type: 'error', message: 'boom' })
    tee.push({ type: 'run-end', run_id: 'run-1', tokens_in: 3, tokens_out: 4, cost_usd: 0.5 })
    await tee.flush()

    const failed = fake.updates.find(u => u.set.status === 'failed')!
    expect(failed.where).toMatch(/"status" = \$\d/)
    expect(failed.params).toContain('running')

    const complete = fake.updates.find(u => u.set.status === 'complete')!
    expect(complete.where).toMatch(/"status" = \$\d/)
    expect(complete.params).toContain('running')

    const usage = fake.updates.find(u => u.set.tokensIn === 3)!
    expect(usage.set).toMatchObject({ tokensOut: 4, costUsd: '0.5' })
    expect(usage.set.status).toBeUndefined()
  })
  it("records the api's cancelled error as a cancelled run", async () => {
    const tee = new AgentRunTee('run-1', 'user-1')
    tee.push({ type: 'error', message: 'cancelled' })
    await tee.flush()

    expect(fake.updates.map(u => u.set.status)).toEqual(['cancelled'])
  })
})
