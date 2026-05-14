import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiClient } from '../../server/llm/http'
import type { H3Event } from 'h3'

type ExecuteReturn = AsyncGenerator<unknown, unknown, unknown>
type ToolMap = Record<
  string,
  { description?: string; execute: (args: Record<string, unknown>, ctx: unknown) => ExecuteReturn }
>

let makeTools: (client: ApiClient, event?: H3Event) => ToolMap
beforeEach(async () => {
  vi.resetModules()
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

function ndjsonResponse(lines: string[]) {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l + '\n'))
      controller.close()
    },
  })
  return { ok: true, body } as unknown as Response
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

  it('streams progress yields and returns the final decision', async () => {
    // Each yield becomes a `tool-output-available` (preliminary) frame on the
    // chat stream — that's what keeps the connection alive during the long
    // agent run AND drives the AgentsDebateCard timeline.
    const tools = makeTools({} as unknown as ApiClient)
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      ndjsonResponse([
        '{"type":"run-start","run_id":"r1","symbol":"NVDA","config":{}}',
        '{"type":"node-start","node":"market"}',
        '{"type":"node-start","node":"trader"}',
        '{"type":"decision","rating":"buy","confidence":72,"rationale":"strong fundamentals"}',
        '{"type":"run-end","run_id":"r1","tokens_in":1,"tokens_out":1,"cost_usd":0.01}',
      ]),
    ) as unknown as typeof fetch
    const gen = tools.agents_debate.execute(
      { symbol: 'NVDA', max_debate_rounds: 1, deep_thinking: true },
      {} as unknown,
    )
    const { yields, final } = await drain(gen)

    // We expect at least one yield per upstream event (plus an initial
    // pre-fetch yield), so >= 5.
    expect(yields.length).toBeGreaterThanOrEqual(5)

    // Final value carries the verdict the LLM consumes.
    expect(final).toMatchObject({ rating: 'buy', confidence: 72, rationale: 'strong fundamentals' })

    // Final value also carries the node timeline for the card.
    const nodes = (final as { events: Array<{ type: string; node?: string }> }).events
      .filter(e => e.type === 'node-start')
      .map(e => e.node)
    expect(nodes).toEqual(['market', 'trader'])
  })

  it('forwards the session cookie when given an event', async () => {
    // Without cookie forwarding the self-fetch hits Nuxt's auth middleware
    // (server/middleware/auth.ts) and gets 401 — surfacing as
    // "agents service failed: 401" in chat.
    const tools = makeTools({} as unknown as ApiClient, fakeEventWithCookie('session=abc123'))
    const fetchSpy = vi.fn(async () =>
      ndjsonResponse(['{"type":"decision","rating":"hold","confidence":1,"rationale":""}']),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    await drain(
      tools.agents_debate.execute(
        { symbol: 'NVDA', max_debate_rounds: 1, deep_thinking: true },
        {} as unknown,
      ),
    )
    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.cookie).toBe('session=abc123')
  })

  it('omits the cookie header when no event is given', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    const fetchSpy = vi.fn(async () =>
      ndjsonResponse(['{"type":"decision","rating":"hold","confidence":1,"rationale":""}']),
    )
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch
    await drain(
      tools.agents_debate.execute(
        { symbol: 'NVDA', max_debate_rounds: 1, deep_thinking: true },
        {} as unknown,
      ),
    )
    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.cookie).toBeUndefined()
  })

  it('returns an error when no decision was emitted', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () =>
      ndjsonResponse(['{"type":"node-start","node":"market"}']),
    ) as unknown as typeof fetch
    const { final } = await drain(
      tools.agents_debate.execute(
        { symbol: 'NVDA', max_debate_rounds: 1, deep_thinking: true },
        {} as unknown,
      ),
    )
    expect(final).toMatchObject({ error: 'no decision emitted' })
  })

  it('returns an error when the upstream service fails', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      body: null,
    })) as unknown as typeof fetch
    const { final } = await drain(
      tools.agents_debate.execute(
        { symbol: 'NVDA', max_debate_rounds: 1, deep_thinking: true },
        {} as unknown,
      ),
    )
    expect(final).toMatchObject({ error: expect.stringContaining('502') })
  })
})
