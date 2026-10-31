import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getEarningsSurprise = vi.fn()
vi.mock('../../server/lib/earnings-surprise', () => ({ getEarningsSurprise: (s: string) => getEarningsSurprise(s) }))

type Handler = (event: H3Event) => unknown
let handler: Handler
const AUTH = { authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }

beforeEach(async () => {
  vi.resetModules()
  getEarningsSurprise.mockReset()
  process.env.INTERNAL_BEARER = 'test-bearer-0123456789abcdef0123456789'
  handler = (await import('../../server/api/internal/yahoo/earnings-surprise.get')).default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  return { node: { req: { headers } }, context: {}, path: search ? `/?${search}` : '/' } as unknown as H3Event
}

describe('/internal/yahoo/earnings-surprise', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'AMZN' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('requires a symbol', async () => {
    await expect(handler(makeEvent(AUTH, {}))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns the surprise table', async () => {
    getEarningsSurprise.mockResolvedValue({ symbol: 'AMZN', quarters: [{ eps_surprise_pct: -3.47 }] })
    const r = (await handler(makeEvent(AUTH, { symbol: 'AMZN' }))) as { quarters: { eps_surprise_pct: number }[] }
    expect(r.quarters[0]?.eps_surprise_pct).toBe(-3.47)
  })

  it('maps a Yahoo failure to 502', async () => {
    getEarningsSurprise.mockRejectedValue(new Error('yahoo down'))
    await expect(handler(makeEvent(AUTH, { symbol: 'AMZN' }))).rejects.toMatchObject({ statusCode: 502 })
  })
})
