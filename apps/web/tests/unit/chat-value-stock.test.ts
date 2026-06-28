import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ApiClient } from '../../server/llm/http'
import type { H3Event } from 'h3'

type ToolMap = Record<
  string,
  { description?: string; execute: (args: Record<string, unknown>) => Promise<unknown> }
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

describe('value_stock tool', () => {
  it('is registered', () => {
    const tools = makeTools({} as unknown as ApiClient)
    expect(tools['value_stock']).toBeDefined()
    expect(typeof tools['value_stock'].description).toBe('string')
  })

  it('calls /api/research/valuation with the correct symbol and returns stubbed JSON', async () => {
    const stubbedResult = {
      symbol: 'AAPL',
      fair_value: 185.0,
      margin_of_safety: 0.12,
    }
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => stubbedResult,
    }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

    const tools = makeTools({} as unknown as ApiClient, fakeEventWithCookie('session=test999'))
    const result = await tools['value_stock'].execute({ symbol: 'AAPL' })

    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/research/valuation')
    expect(url).toContain('symbol=AAPL')

    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.cookie).toBe('session=test999')

    expect(result).toEqual(stubbedResult)
  })

  it('forwards the session cookie when given an event', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ symbol: 'AAPL' }),
    }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

    const tools = makeTools({} as unknown as ApiClient, fakeEventWithCookie('session=abc123'))
    await tools['value_stock'].execute({ symbol: 'AAPL' })

    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.cookie).toBe('session=abc123')
  })

  it('omits the cookie header when no event is given', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ symbol: 'AAPL' }),
    }))
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch

    const tools = makeTools({} as unknown as ApiClient)
    await tools['value_stock'].execute({ symbol: 'AAPL' })

    const init = (fetchSpy.mock.calls[0]?.[1] ?? {}) as RequestInit
    const headers = (init.headers ?? {}) as Record<string, string>
    expect(headers.cookie).toBeUndefined()
  })

  it('returns an error object when the upstream service fails', async () => {
    ;(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
    })) as unknown as typeof fetch

    const tools = makeTools({} as unknown as ApiClient)
    const result = await tools['value_stock'].execute({ symbol: 'AAPL' })
    expect(result).toMatchObject({ error: expect.stringContaining('503') })
  })
})
