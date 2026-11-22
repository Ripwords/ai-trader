import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiClient } from '../../server/llm/http'
import type { H3Event } from 'h3'

type ToolMap = Record<string, {
  description?: string
  execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown>
}>

let makeTools: (client: ApiClient, arg?: unknown) => ToolMap
beforeEach(async () => {
  vi.resetModules()
  makeTools = (await import('../../server/llm/tools')).makeTools as unknown as typeof makeTools
})

function fakeEventWithCookie(cookie: string): H3Event {
  return { node: { req: { headers: { cookie } } } } as unknown as H3Event
}
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('research_start tool', () => {
  it('is defined with a schema', () => {
    const tools = makeTools({} as unknown as ApiClient)
    expect(tools.research_start).toBeDefined()
    expect(typeof tools.research_start.description).toBe('string')
  })

  it('posts to agents-run and returns the run id + a notify hint', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { runId: 'run-9', status: 'running', symbol: 'NVDA' }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient, fakeEventWithCookie('session=abc'))
    const out = await tools.research_start.execute({ symbol: 'NVDA' }, {} as unknown) as Record<string, unknown>

    const url = String(fetchSpy.mock.calls[0]?.[0])
    expect(url).toMatch(/\/api\/research\/agents-run$/)
    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit
    expect((init.headers as Record<string, string>).cookie).toBe('session=abc')
    // A background run keeps its own "research done" push: the chat reply ends long before it.
    expect(JSON.parse(String(init.body)).origin).toBeUndefined()
    expect(out).toMatchObject({ runId: 'run-9', status: 'running', symbol: 'NVDA' })
    expect(String(out.message)).toMatch(/notif/i)
  })

  it('surfaces a 409 duplicate as a friendly already-running result', async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      jsonResponse(409, { data: { run_id: 'existing-1' } })) as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient)
    const out = await tools.research_start.execute({ symbol: 'NVDA' }, {} as unknown) as Record<string, unknown>
    expect(out).toMatchObject({ status: 'already_running', runId: 'existing-1' })
  })

  it('returns { status: "error" } when self-fetch returns a non-ok, non-409 status', async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      jsonResponse(500, {})) as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient)
    const out = await tools.research_start.execute({ symbol: 'NVDA' }, {} as unknown) as Record<string, unknown>
    expect(out.status).toBe('error')
    expect(typeof out.error).toBe('string')
    expect(String(out.error)).toMatch(/500/)
  })

  it('passes on the reason the run could not start', async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      jsonResponse(503, { statusMessage: 'symbol lookup failed, try again' })) as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient)
    const out = await tools.research_start.execute({ symbol: 'VZ' }, {} as unknown) as Record<string, unknown>
    expect(String(out.error)).toContain('symbol lookup failed, try again')
  })
})

// research_get by runId is how the chat checks on a run research_start began:
// it reports the run's status while it is still going, with no verdict yet.
describe('research_get tool', () => {
  it('reports a still-running run by runId, so no separate status tool is needed', async () => {
    vi.doMock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))
    vi.doMock('../../server/lib/agents/runs-query', () => ({
      getRunVerdict: vi.fn(async (_u: string, runId: string) => ({
        runId, symbol: 'NVDA', status: 'running', finishedAt: null, rating: null, no_verdict_reason: 'the run is still in progress',
      })),
      getLatestRunForSymbol: vi.fn(async () => null),
      getLatestAttemptForSymbol: vi.fn(async () => null),
    }))
    const tools = makeTools({} as unknown as ApiClient)
    const out = await tools.research_get.execute({ runId: 'run-9' }, {} as unknown) as Record<string, unknown>
    expect(out).toMatchObject({ runId: 'run-9', status: 'running', rating: null })
    vi.doUnmock('../../server/db/repo')
    vi.doUnmock('../../server/lib/agents/runs-query')
  })

  it('tells the model to check progress with research_get, not a removed tool', () => {
    const tools = makeTools({} as unknown as ApiClient)
    expect(tools.research_status).toBeUndefined()
    expect(tools.research_get.description).toMatch(/still running|in progress/i)
  })

  it('points the research_start reply at research_get for progress', async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      jsonResponse(200, { runId: 'run-9', status: 'running', symbol: 'NVDA' })) as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient)
    const out = await tools.research_start.execute({ symbol: 'NVDA' }, {} as unknown) as Record<string, unknown>
    expect(String(out.message)).toContain('research_get')
    expect(tools.research_start.description).not.toContain('research_status')
  })
})
