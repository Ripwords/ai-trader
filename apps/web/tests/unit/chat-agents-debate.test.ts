import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiClient } from '../../server/llm/http'
import type { H3Event } from 'h3'
import type { AgentEvent } from '../../types/agents'
import type { RunFrame } from '../../server/lib/agents/run-events'

type ExecuteReturn = AsyncGenerator<unknown, unknown, unknown>
type ToolMap = Record<
  string,
  { description?: string; execute: (args: Record<string, unknown>, ctx: unknown) => ExecuteReturn }
>

let tailFrames: RunFrame[] = []
const { tailRun } = vi.hoisted(() => ({
  tailRun: vi.fn(async function* (): AsyncGenerator<RunFrame> {
    for (const f of tailFrames) yield f
  }),
}))
vi.mock('../../server/lib/agents/run-events', () => ({ tailRun }))

let makeTools: (client: ApiClient, event?: H3Event) => ToolMap
beforeEach(async () => {
  vi.resetModules()
  tailRun.mockClear()
  tailFrames = []
  makeTools = (await import('../../server/llm/tools')).makeTools as unknown as (
    client: ApiClient,
    event?: H3Event,
  ) => ToolMap
})

function fakeEventWithCookie(cookie: string): H3Event {
  return {
    node: { req: { headers: { cookie } } },
  } as unknown as H3Event
}

const args = { symbol: 'NVDA', max_debate_rounds: 1, deep_thinking: true }

function ev(seq: number, event: AgentEvent): RunFrame {
  return { kind: 'event', seq, event }
}

function startResponse() {
  const fetchSpy = vi.fn(async () => Response.json({ runId: 'run-1', status: 'running', symbol: 'NVDA' }))
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
  return fetchSpy
}

async function drain(gen: ExecuteReturn): Promise<{ yields: unknown[]; final: unknown }> {
  const yields: unknown[] = []
  let final: unknown
  while (true) {
    const r = await gen.next()
    if (r.done) {
      final = r.value
      break
    }
    yields.push(r.value)
  }
  return { yields, final }
}

describe('agents_debate tool catalogue', () => {
  it('exists and has correct schema', () => {
    const tools = makeTools({} as unknown as ApiClient)
    expect(tools.agents_debate).toBeDefined()
    expect(typeof tools.agents_debate.description).toBe('string')
  })

  it('removes the persona-era tools', () => {
    const tools = makeTools({} as unknown as ApiClient)
    expect(tools.research_ticker).toBeUndefined()
    expect(tools.synthesize_decisions).toBeUndefined()
    expect(tools.analyze_ticker).toBeUndefined()
  })

  it('starts a detached run, streams progress yields, and returns the final decision', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    const fetchSpy = startResponse()
    tailFrames = [
      ev(0, { type: 'run-start', run_id: 'run-1', symbol: 'NVDA', config: {} }),
      ev(1, { type: 'node-start', node: 'market' }),
      ev(2, { type: 'node-start', node: 'trader' }),
      ev(3, { type: 'decision', rating: 'buy', confidence: 72, rationale: 'strong fundamentals' }),
      ev(4, { type: 'run-end', run_id: 'run-1', tokens_in: 1, tokens_out: 1, cost_usd: 0.01 }),
      { kind: 'end', status: 'complete', error: null },
    ]
    const { yields, final } = await drain(tools.agents_debate.execute(args, {} as unknown))

    expect(fetchSpy.mock.calls[0]?.[0]).toContain('/api/research/agents-run')
    expect(tailRun).toHaveBeenCalledWith('run-1', expect.anything())
    // One yield before the run starts plus one per event keeps the chat
    // stream moving and drives the AgentsDebateCard timeline.
    expect(yields.length).toBeGreaterThanOrEqual(6)
    expect(final).toMatchObject({ runId: 'run-1', rating: 'buy', confidence: 72, rationale: 'strong fundamentals' })
    const nodes = (final as { events: Array<{ node?: string }> }).events.map(e => e.node)
    expect(nodes).toEqual(['market', 'trader'])
  })

  it('forwards the session cookie when given an event', async () => {
    const tools = makeTools({} as unknown as ApiClient, fakeEventWithCookie('session=abc123'))
    const fetchSpy = startResponse()
    tailFrames = [{ kind: 'end', status: 'complete', error: null }]
    await drain(tools.agents_debate.execute(args, {} as unknown))
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers.cookie).toBe('session=abc123')
  })

  it('omits the cookie header when no event is given', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    const fetchSpy = startResponse()
    tailFrames = [{ kind: 'end', status: 'complete', error: null }]
    await drain(tools.agents_debate.execute(args, {} as unknown))
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers.cookie).toBeUndefined()
  })

  it('returns an error when the run completes without a decision', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    startResponse()
    tailFrames = [ev(0, { type: 'node-start', node: 'market' }), { kind: 'end', status: 'complete', error: null }]
    const { final } = await drain(tools.agents_debate.execute(args, {} as unknown))
    expect(final).toMatchObject({ error: 'no decision emitted' })
  })

  it('returns the failure reason when the run fails', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    startResponse()
    tailFrames = [{ kind: 'end', status: 'failed', error: 'stream ended without terminal event' }]
    const { final } = await drain(tools.agents_debate.execute(args, {} as unknown))
    expect(final).toMatchObject({ runId: 'run-1', error: 'run failed: stream ended without terminal event' })
  })

  it('returns an error when the run cannot start', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      new Response('{}', { status: 502 }),
    ) as unknown as typeof fetch
    const { final } = await drain(tools.agents_debate.execute(args, {} as unknown))
    expect(final).toMatchObject({ error: expect.stringContaining('502') })
    expect(tailRun).not.toHaveBeenCalled()
  })
})
