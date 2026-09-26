import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from './support/fake-db'

let runRow: Record<string, unknown> = {}
let fake = createFakeDb()
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))
vi.mock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
vi.mock('../../server/lib/yahoo', () => ({ resolveSymbol: vi.fn() }))
vi.mock('h3', async (orig) => {
  const actual = await orig<typeof import('h3')>()
  return { ...actual, readBody: (e: { _body: unknown }) => Promise.resolve(e._body) }
})

const handler = (await import('../../server/api/research/agents-resume.post')).default as (e: H3Event) => Promise<unknown>

const makeEvent = (body: unknown) => ({ _body: body, context: {}, node: { req: {}, res: {} } }) as unknown as H3Event

function ndjson(lines: string[]): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l + '\n'))
      c.close()
    },
  }))
}

beforeEach(() => {
  runRow = { id: 'run-1', userId: 'user-1', status: 'failed', symbol: 'NVDA', tradeDate: '2026-05-10' }
  fake = createFakeDb(table => table === 'agent_runs' ? [runRow] : [{ maxSeq: 5 }])
  vi.stubGlobal('fetch', vi.fn(async () => ndjson([
    '{"type":"decision","rating":"hold","confidence":50,"rationale":"resumed"}',
    '{"type":"run-end","run_id":"run-1","tokens_in":1,"tokens_out":1,"cost_usd":0}',
  ])))
})

describe('POST /api/research/agents-resume', () => {
  it('returns the run id and appends resumed events after the existing ones', async () => {
    const res = await handler(makeEvent({ run_id: 'run-1' }))

    expect(res).toEqual({ runId: 'run-1', status: 'running' })
    await vi.waitFor(() => {
      const seqs = fake.inserts.filter(i => i.table === 'agent_messages').map(i => i.values.seq)
      expect(seqs).toEqual([6, 7])
    })
    expect(fake.updates[0]!.set).toMatchObject({ status: 'running', error: null, finishedAt: null })
  })

  it('refuses to resume a run that is still running', async () => {
    runRow.status = 'running'
    await expect(handler(makeEvent({ run_id: 'run-1' }))).rejects.toMatchObject({ statusCode: 409 })
    expect(fetch).not.toHaveBeenCalled()
  })
})
