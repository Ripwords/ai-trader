import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchMock = vi.fn()
vi.mock('../../server/lib/search', () => ({
  searchWithFallback: searchMock,
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  searchMock.mockReset()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/internal/news/symbol.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: { headers } }, context: {}, path } as unknown as H3Event
}

describe('/internal/news/symbol', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns results on bearer match', async () => {
    searchMock.mockResolvedValueOnce([{ title: 'NVDA up', url: 'https://x', content: 'body' }])
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as { symbol: string; results: { title: string }[] }
    expect(result.symbol).toBe('NVDA')
    expect(result.results).toHaveLength(1)
    expect(result.results[0].title).toBe('NVDA up')
  })

  it('returns empty results + error string when search fails (no throw)', async () => {
    searchMock.mockRejectedValueOnce(new Error('no key'))
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as { symbol: string; results: unknown[]; error?: string }
    expect(result.results).toEqual([])
    expect(result.error).toBe('no key')
  })
})
