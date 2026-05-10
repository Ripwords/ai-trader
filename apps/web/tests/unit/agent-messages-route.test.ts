import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runSelectLimit = vi.fn()
const messagesOrderLimit = vi.fn()

vi.mock('../../db/client', () => ({
  getDb: () => ({
    select: vi.fn((shape: unknown) => {
      // Two select shapes: run lookup vs messages lookup. Distinguish by the
      // presence of a ``payload`` key in the projection.
      const projection = shape as Record<string, unknown>
      if ('payload' in projection) {
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({ limit: messagesOrderLimit }),
            }),
          }),
        }
      }
      return {
        from: () => ({
          where: () => ({ limit: runSelectLimit }),
        }),
      }
    }),
  }),
}))

vi.mock('../../server/db/repo', () => ({
  getOwnerId: vi.fn().mockResolvedValue('owner-1'),
}))

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    getQuery: vi.fn(
      (event: { _query?: Record<string, string | undefined> }) => event._query ?? {},
    ),
  }
})

type Handler = (event: H3Event) => Promise<unknown>
let handler: Handler

beforeEach(async () => {
  vi.resetModules()
  runSelectLimit.mockReset()
  messagesOrderLimit.mockReset()

  const mod = await import('../../server/api/research/agent-messages.get')
  handler = mod.default as Handler
})

function makeEvent(query: Record<string, string | undefined>): H3Event {
  return {
    node: { res: { setHeader: vi.fn() } },
    headers: {},
    method: 'GET',
    _query: query,
    context: {},
  } as unknown as H3Event
}

describe('GET /api/research/agent-messages', () => {
  it('rejects missing run_id with 400', async () => {
    runSelectLimit.mockResolvedValue([])
    messagesOrderLimit.mockResolvedValue([])
    await expect(handler(makeEvent({}))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns 404 when the run is not owned by the caller', async () => {
    runSelectLimit.mockResolvedValue([
      { id: 'r-1', status: 'complete', finishedAt: null, userId: 'someone-else' },
    ])
    messagesOrderLimit.mockResolvedValue([])
    await expect(handler(makeEvent({ run_id: 'r-1' }))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('replays messages with current run status and lastSeq', async () => {
    runSelectLimit.mockResolvedValue([
      { id: 'r-1', status: 'complete', finishedAt: '2026-05-10T00:00:00Z', userId: 'owner-1' },
    ])
    messagesOrderLimit.mockResolvedValue([
      { seq: 0, payload: { type: 'run-start', run_id: 'r-1', symbol: 'NVDA', config: {} } },
      { seq: 1, payload: { type: 'node-start', node: 'fundamentals_analyst' } },
      { seq: 2, payload: { type: 'run-end', run_id: 'r-1', tokens_in: 0, tokens_out: 0, cost_usd: 0 } },
    ])
    const result = (await handler(makeEvent({ run_id: 'r-1' }))) as {
      runId: string
      status: string
      lastSeq: number
      events: unknown[]
    }
    expect(result.runId).toBe('r-1')
    expect(result.status).toBe('complete')
    expect(result.lastSeq).toBe(2)
    expect(result.events.length).toBe(3)
  })
})
