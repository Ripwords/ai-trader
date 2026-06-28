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

  it('posts to agents-run-async and returns the run id + a notify hint', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(200, { runId: 'run-9', status: 'running', symbol: 'NVDA' }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient, fakeEventWithCookie('session=abc'))
    const out = await tools.research_start.execute({ symbol: 'NVDA' }, {} as unknown) as Record<string, unknown>

    const url = String(fetchSpy.mock.calls[0]?.[0])
    expect(url).toContain('/api/research/agents-run-async')
    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit
    expect((init.headers as Record<string, string>).cookie).toBe('session=abc')
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
})

describe('research_status tool', () => {
  it('returns the run status from agent-messages', async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      jsonResponse(200, { runId: 'run-9', status: 'complete', lastSeq: 12 })) as unknown as typeof fetch
    const tools = makeTools({} as unknown as ApiClient)
    const out = await tools.research_status.execute({ runId: 'run-9' }, {} as unknown) as Record<string, unknown>
    expect(out).toMatchObject({ runId: 'run-9', status: 'complete' })
  })
})
