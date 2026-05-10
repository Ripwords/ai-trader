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
  const mod = await import('../../server/internal/news/global.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: { headers } }, context: {}, path } as unknown as H3Event
}

describe('/internal/news/global', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, {}))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('uses default macro query when none given', async () => {
    searchMock.mockResolvedValueOnce([])
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, {})
    const result = (await handler(event)) as { query: string; results: unknown[] }
    expect(result.query).toBe('global macroeconomic news')
    expect(searchMock).toHaveBeenCalledWith('news', 'global macroeconomic news', 10)
  })

  it('returns empty results + error on failure', async () => {
    searchMock.mockRejectedValueOnce(new Error('boom'))
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, { query: 'oil' })
    const result = (await handler(event)) as { query: string; results: unknown[]; error?: string }
    expect(result.query).toBe('oil')
    expect(result.results).toEqual([])
    expect(result.error).toBe('boom')
  })
})
