import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiClient } from '../../server/llm/http'

type ToolMap = Record<string, { description?: string; execute: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> }>

let makeTools: (client: ApiClient) => ToolMap
beforeEach(async () => {
  vi.resetModules()
  makeTools = (await import('../../server/llm/tools')).makeTools as unknown as (client: ApiClient) => ToolMap
})

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

  it('agents_debate.execute streams NDJSON and returns the final decision', async () => {
    const tools = makeTools({} as unknown as ApiClient)
    const enc = new TextEncoder()
    const lines = [
      '{"type":"run-start","run_id":"r1","symbol":"NVDA","config":{}}',
      '{"type":"node-start","node":"trader"}',
      '{"type":"decision","rating":"buy","confidence":72,"rationale":"strong fundamentals"}',
      '{"type":"run-end","run_id":"r1","tokens_in":1,"tokens_out":1,"cost_usd":0.01}',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const l of lines) controller.enqueue(enc.encode(l + '\n'))
        controller.close()
      },
    })
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => ({ ok: true, body })) as unknown as typeof fetch
    const result = await tools.agents_debate.execute(
      { symbol: 'NVDA', max_debate_rounds: 1, deep_thinking: true },
      {} as unknown,
    )
    expect(result).toMatchObject({ rating: 'buy', confidence: 72 })
  })
})
