import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveSymbol = vi.fn()
const getOwnerId = vi.fn().mockResolvedValue('user-1')
const getDb = vi.fn(() => {
  throw new Error('getDb must not be called for an unresolved symbol')
})

vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: (...a: unknown[]) => resolveSymbol(...a),
}))
vi.mock('../../server/db/repo', () => ({ getOwnerId: () => getOwnerId() }))
vi.mock('../../db/client', () => ({ getDb: () => getDb() }))
vi.mock('../../db/schema', () => ({ agentRuns: {} }))
vi.mock('../../server/utils/agents-tee', () => ({ AgentRunTee: class {} }))

type Handler = (event: H3Event) => unknown
let handler: Handler
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  resolveSymbol.mockReset()
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  const mod = await import('../../server/api/research/agents-run.post')
  handler = mod.default as Handler
})

function makeEvent(body: Record<string, unknown>): H3Event {
  return {
    node: { req: { method: 'POST' }, res: { setHeader: vi.fn() } },
    context: {},
    _body: body,
  } as unknown as H3Event
}

// readBody reads event._body in h3's test shim path; stub it explicitly.
vi.mock('h3', async (orig) => {
  const actual = await orig<typeof import('h3')>()
  return {
    ...actual,
    readBody: (e: { _body: unknown }) => Promise.resolve(e._body),
  }
})

describe('/api/research/agents-run — canonical resolution gate', () => {
  it('422s an unresolved symbol and never reaches the DB or FastAPI', async () => {
    resolveSymbol.mockResolvedValue({ status: 'not_found' })

    await expect(handler(makeEvent({ symbol: 'US.MU' }))).rejects.toMatchObject({
      statusCode: 422,
    })

    expect(resolveSymbol).toHaveBeenCalledWith('US.MU')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('surfaces ambiguous candidates in the 422 payload', async () => {
    resolveSymbol.mockResolvedValue({
      status: 'ambiguous',
      candidates: [{ moomoo: 'US.MU', yahoo: 'MU', name: 'Micron', exchange: 'NASDAQ', type: 'Equity' }],
    })

    await expect(handler(makeEvent({ symbol: 'MU' }))).rejects.toMatchObject({
      statusCode: 422,
      data: { status: 'ambiguous' },
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
