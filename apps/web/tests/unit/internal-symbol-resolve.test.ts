import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveSymbol = vi.fn()

vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: (...args: unknown[]) => resolveSymbol(...args),
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  resolveSymbol.mockReset()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/api/internal/symbol/resolve.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: { headers } }, context: {}, path } as unknown as H3Event
}

const bearer = { authorization: 'Bearer test-bearer' }

describe('/internal/symbol/resolve', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { q: 'US.MU' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('400 when q is missing', async () => {
    await expect(handler(makeEvent(bearer, {}))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns the resolved union', async () => {
    resolveSymbol.mockResolvedValue({
      status: 'resolved', symbol: 'US.MU', moomoo: 'US.MU', yahoo: 'MU',
      name: 'Micron Technology, Inc.', exchange: 'NASDAQ', quoteType: 'Equity',
    })
    const r = await handler(makeEvent(bearer, { q: 'US.MU' }))
    expect(r).toMatchObject({ status: 'resolved', moomoo: 'US.MU', name: 'Micron Technology, Inc.' })
    expect(resolveSymbol).toHaveBeenCalledWith('US.MU')
  })

  it('passes through ambiguous/not_found/error verbatim', async () => {
    resolveSymbol.mockResolvedValue({ status: 'not_found' })
    expect(await handler(makeEvent(bearer, { q: 'ZZZZ' }))).toEqual({ status: 'not_found' })
  })
})
