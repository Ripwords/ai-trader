import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from './support/fake-db'

let fake = createFakeDb()
let draining = false
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))
vi.mock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
vi.mock('../../server/lib/agents/start-run', () => ({ isDraining: () => draining }))
vi.mock('h3', async (orig) => {
  const actual = await orig<typeof import('h3')>()
  return { ...actual, getQuery: (e: { _query: unknown }) => e._query }
})

const handler = (await import('../../server/api/research/agents-run.delete')).default as (e: H3Event) => Promise<unknown>

const makeEvent = (runId: string) => ({ _query: { run_id: runId }, context: {}, node: { req: {}, res: {} } }) as unknown as H3Event

function apiSays(cancelled: boolean) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, cancelled })))
}

beforeEach(() => {
  fake = createFakeDb()
  draining = false
})

describe('DELETE /api/research/agents-run', () => {
  it('leaves the status to the drain when the api cancelled a live task', async () => {
    apiSays(true)
    await handler(makeEvent('run-1'))

    // The api still streams error: cancelled and run-end; the tee records them.
    expect(fake.updates).toEqual([])
  })

  it('cancels only a run that is still running when the api no longer tracks it', async () => {
    apiSays(false)
    await handler(makeEvent('run-1'))

    expect(fake.updates).toHaveLength(1)
    const [u] = fake.updates
    expect(u!.set).toMatchObject({ status: 'cancelled' })
    expect(u!.where).toMatch(/"status" = \$\d/)
    expect(u!.params).toEqual(expect.arrayContaining(['run-1', 'user-1', 'running']))
  })

  it('does not write over a drain that is still recording the run', async () => {
    apiSays(false)
    draining = true
    await handler(makeEvent('run-1'))

    expect(fake.updates).toEqual([])
  })
})
