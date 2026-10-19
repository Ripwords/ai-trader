import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubNitroCache } from '../fixtures/nitro-cache'

const resolveSymbol = vi.fn()

vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: (...args: unknown[]) => resolveSymbol(...args),
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  resolveSymbol.mockReset()
  fetchSpy = vi.fn()
  vi.stubGlobal('fetch', fetchSpy)
  stubNitroCache()
  const mod = await import('../../server/api/research/valuation.get')
  handler = mod.default as Handler
})

function makeEvent(query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: {} }, context: {}, path } as unknown as H3Event
}

describe('/api/research/valuation proxy', () => {
  it('400 when symbol query param is missing', async () => {
    await expect(handler(makeEvent({}))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('422 when symbol cannot be resolved', async () => {
    resolveSymbol.mockResolvedValue({ status: 'not_found' })
    await expect(handler(makeEvent({ symbol: 'ZZZZ' }))).rejects.toMatchObject({ statusCode: 422 })
    expect(resolveSymbol).toHaveBeenCalledWith('ZZZZ')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves symbol then forwards and returns the api JSON', async () => {
    resolveSymbol.mockResolvedValue({ status: 'resolved', symbol: 'AAPL', name: 'Apple Inc.' })
    const apiPayload = { symbol: 'AAPL', data_quality: 'full', fair_value: 150 }
    fetchSpy.mockResolvedValue({ ok: true, json: async () => apiPayload })

    const result = await handler(makeEvent({ symbol: 'AAPL' }))

    expect(resolveSymbol).toHaveBeenCalledWith('AAPL')
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/valuation?symbol=AAPL'),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: expect.any(String) }) }),
    )
    expect(result).toEqual(apiPayload)
  })

  it('serves a repeat valuation of the same resolved symbol from cache', async () => {
    resolveSymbol.mockResolvedValue({ status: 'resolved', symbol: 'AAPL', name: 'Apple Inc.' })
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ symbol: 'AAPL', fair_value: 150 }) })

    await handler(makeEvent({ symbol: 'aapl' }))
    const second = await handler(makeEvent({ symbol: 'AAPL' }))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ symbol: 'AAPL', fair_value: 150 })
  })

  it('does not cache an upstream failure', async () => {
    resolveSymbol.mockResolvedValue({ status: 'resolved', symbol: 'AAPL', name: 'Apple Inc.' })
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 502 })
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({ symbol: 'AAPL' }) })

    await expect(handler(makeEvent({ symbol: 'AAPL' }))).rejects.toMatchObject({ statusCode: 502 })
    await expect(handler(makeEvent({ symbol: 'AAPL' }))).resolves.toEqual({ symbol: 'AAPL' })
  })
})
