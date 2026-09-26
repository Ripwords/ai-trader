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
  it("writes the terminal status once, after the api's trailing run-end row", async () => {
    const tee = new AgentRunTee('run-1', 'user-1')
    tee.push({ type: 'error', message: 'boom' })
    await tee.flush()
    // An error is not the end: run-end (tokens, cost) still follows it.
    expect(fake.updates.filter(u => u.set.status)).toEqual([])

    tee.push({ type: 'run-end', run_id: 'run-1', tokens_in: 3, tokens_out: 4, cost_usd: 0.5 })
    await tee.flush()

    const usage = fake.updates.find(u => u.set.tokensIn === 3)!
    expect(usage.set).toMatchObject({ tokensOut: 4, costUsd: '0.5' })
    expect(usage.set.status).toBeUndefined()
    const terminal = fake.updates.filter(u => u.set.status)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]!.set).toMatchObject({ status: 'failed', error: 'boom' })
    expect(terminal[0]!.where).toMatch(/"status" = \$\d/)
    expect(terminal[0]!.params).toContain('running')
    expect(fake.updates.indexOf(terminal[0]!)).toBeGreaterThan(fake.updates.indexOf(usage))
  })

  it('completes a run whose stream ended with run-end and no error', async () => {
    const tee = new AgentRunTee('run-1', 'user-1')
    tee.push({ type: 'run-end', run_id: 'run-1', tokens_in: 1, tokens_out: 1, cost_usd: 0 })
    await tee.end('unused')

    expect(fake.updates.filter(u => u.set.status).map(u => u.set)).toMatchObject([{ status: 'complete', error: null }])
  })

  it("records the api's cancelled error as a cancelled run", async () => {
    const tee = new AgentRunTee('run-1', 'user-1')
    tee.push({ type: 'error', message: 'cancelled' })
    tee.push({ type: 'run-end', run_id: 'run-1', tokens_in: 0, tokens_out: 0, cost_usd: 0 })
    await tee.flush()

    expect(fake.updates.filter(u => u.set.status).map(u => u.set.status)).toEqual(['cancelled'])
  })

  it('ends a stream that stopped after an error without run-end, keeping that error', async () => {
    const tee = new AgentRunTee('run-1', 'user-1')
    tee.push({ type: 'error', message: 'boom' })
    await tee.end('stream ended without terminal event')

    const kinds = fake.inserts.filter(i => i.table === 'agent_messages').map(i => i.values.kind)
    expect(kinds).toEqual(['error'])
    expect(fake.updates.filter(u => u.set.status).map(u => u.set)).toMatchObject([{ status: 'failed', error: 'boom' }])
  })
})
