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
})
