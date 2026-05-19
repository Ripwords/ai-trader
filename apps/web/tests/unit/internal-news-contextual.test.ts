import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getContextualNewsMock = vi.fn()
vi.mock('../../server/lib/contextual-news', () => ({
  getContextualNews: getContextualNewsMock,
}))

type Handler = (event: H3Event) => unknown
let handler: Handler

beforeEach(async () => {
  vi.resetModules()
  getContextualNewsMock.mockReset()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/api/internal/news/contextual.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  return { node: { req: { headers } }, context: {}, path: search ? `/?${search}` : '/' } as unknown as H3Event
}

describe('/internal/news/contextual', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('400 when symbol missing', async () => {
    await expect(
      handler(makeEvent({ authorization: 'Bearer test-bearer' }, {})),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns grouped results', async () => {
    getContextualNewsMock.mockResolvedValue({
      ticker: [{ title: 't', url: 'u1', content: 'c' }],
      macro: [{ title: 'm', url: 'u2', content: 'c' }],
      contextual: [],
    })
    const res = (await handler(
      makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA', company: 'NVIDIA Corp' }),
    )) as { symbol: string; ticker: unknown[]; macro: unknown[]; contextual: unknown[] }
    expect(res.symbol).toBe('NVDA')
    expect(res.ticker).toHaveLength(1)
    expect(res.macro).toHaveLength(1)
    expect(getContextualNewsMock).toHaveBeenCalledWith({
      symbol: 'NVDA',
      companyName: 'NVIDIA Corp',
      maxResults: 10,
    })
  })

  it('returns empty groups + error on failure', async () => {
    getContextualNewsMock.mockRejectedValue(new Error('boom'))
    const res = (await handler(
      makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA' }),
    )) as { ticker: unknown[]; macro: unknown[]; contextual: unknown[]; error?: string }
    expect(res.ticker).toEqual([])
    expect(res.macro).toEqual([])
    expect(res.contextual).toEqual([])
    expect(res.error).toBe('boom')
  })
})
