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

// What the run left in the database by the time its tail ends.
let stored: Record<string, unknown> | null = null
const { getRunVerdict } = vi.hoisted(() => ({
  getRunVerdict: vi.fn(async (_userId: string, runId: string) => (stored ? { runId, ...stored } : null)),
}))
vi.mock('../../server/lib/agents/runs-query', () => ({ getRunVerdict }))
vi.mock('../../server/db/repo', () => ({ getOwnerId: async () => 'user-1' }))

let makeTools: (client: ApiClient, event?: H3Event) => ToolMap
beforeEach(async () => {
  vi.resetModules()
  tailRun.mockClear()
  getRunVerdict.mockClear()
  tailFrames = []
  stored = null
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

// Mirrors the AI SDK's executeTool: a generator's final output is its last
// yield; whatever it returns is discarded.
async function drain(gen: ExecuteReturn): Promise<{ yields: unknown[]; final: unknown }> {
  const yields: unknown[] = []
  for await (const output of gen) yields.push(output)
  return { yields, final: yields.at(-1) }
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

  it('starts a detached run, streams progress yields, and returns the stored verdict', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    const fetchSpy = startResponse()
    stored = { status: 'complete', rating: 'buy', confidence: 72, rationale: 'strong fundamentals', bull_case: 'AWS grew 39.3%.' }
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
    const progress = yields.at(-2) as { events: Array<{ node?: string }> }
    expect(progress.events.map(e => e.node)).toEqual(['market', 'trader'])
    expect(progress).not.toHaveProperty('rationale')
    expect(getRunVerdict).toHaveBeenCalledWith('user-1', 'run-1')
    expect(final).toEqual({ runId: 'run-1', ...stored })
  })

  it('gives the model the verdict without the progress events', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    startResponse()
    stored = { status: 'complete', rating: 'buy', confidence: 72, rationale: 'strong fundamentals' }
    tailFrames = [ev(0, { type: 'node-start', node: 'market' }), { kind: 'end', status: 'complete', error: null }]
    const { final } = await drain(tools.agents_debate.execute(args, {} as unknown))
    expect(final).not.toHaveProperty('events')
  })

  it('keeps the verdict a failed run still reached, with the failure', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    startResponse()
    stored = { status: 'failed', rating: 'hold', confidence: null, rationale: 'mixed' }
    tailFrames = [{ kind: 'end', status: 'failed', error: 'confidence judge crashed' }]
    const { final } = await drain(tools.agents_debate.execute(args, {} as unknown))
    expect(final).toMatchObject({ runId: 'run-1', rating: 'hold', error: 'run failed: confidence judge crashed' })
  })

  it('forwards the session cookie when given an event', async () => {
    const tools = makeTools({} as unknown as ApiClient, fakeEventWithCookie('session=abc123'))
    const fetchSpy = startResponse()
    tailFrames = [{ kind: 'end', status: 'complete', error: null }]
    await drain(tools.agents_debate.execute(args, {} as unknown))
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>
    expect(headers.cookie).toBe('session=abc123')
  })

  it('marks the run as chat-started, so only the chat reply notifies', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    const fetchSpy = startResponse()
    tailFrames = [{ kind: 'end', status: 'complete', error: null }]
    await drain(tools.agents_debate.execute(args, {} as unknown))
    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body))
    expect(body).toMatchObject({ origin: 'chat' })
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
    stored = { status: 'complete', rating: null, no_verdict_reason: 'the run completed without a decision' }
    tailFrames = [ev(0, { type: 'node-start', node: 'market' }), { kind: 'end', status: 'complete', error: null }]
    const { final } = await drain(tools.agents_debate.execute(args, {} as unknown))
    expect(final).toMatchObject({ runId: 'run-1', error: 'no decision emitted' })
    expect(final).not.toHaveProperty('events')
  })

  it('returns the failure reason when the run fails', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    startResponse()
    tailFrames = [{ kind: 'end', status: 'failed', error: 'stream ended without terminal event' }]
    const { final } = await drain(tools.agents_debate.execute(args, {} as unknown))
    expect(final).toMatchObject({ runId: 'run-1', error: 'run failed: stream ended without terminal event' })
  })

  it('follows the run already in flight for the symbol instead of failing on 409', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      Response.json({ statusCode: 409, data: { run_id: 'run-live' } }, { status: 409 }),
    ) as unknown as typeof fetch
    stored = { status: 'complete', rating: 'hold', confidence: 55, rationale: 'mixed' }
    tailFrames = [
      ev(7, { type: 'decision', rating: 'hold', confidence: 55, rationale: 'mixed' }),
      { kind: 'end', status: 'complete', error: null },
    ]
    const { final } = await drain(tools.agents_debate.execute(args, {} as unknown))

    expect(tailRun).toHaveBeenCalledWith('run-live', expect.anything())
    expect(final).toMatchObject({ runId: 'run-live', rating: 'hold' })
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

  it('passes on the reason the run could not start', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      Response.json({ statusCode: 503, statusMessage: 'symbol lookup failed, try again' }, { status: 503 }),
    ) as unknown as typeof fetch
    const { final } = await drain(tools.agents_debate.execute(args, {} as unknown))
    expect(final).toMatchObject({ error: expect.stringContaining('symbol lookup failed, try again') })
  })
})
