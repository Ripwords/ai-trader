import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getLatestEarningsRelease = vi.fn()
vi.mock('../../server/lib/sec-edgar', () => ({ getLatestEarningsRelease: (s: string) => getLatestEarningsRelease(s) }))

type Handler = (event: H3Event) => unknown
let handler: Handler
const AUTH = { authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }

beforeEach(async () => {
  vi.resetModules()
  getLatestEarningsRelease.mockReset()
  process.env.INTERNAL_BEARER = 'test-bearer-0123456789abcdef0123456789'
  handler = (await import('../../server/api/internal/sec/earnings-release.get')).default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  return { node: { req: { headers } }, context: {}, path: search ? `/?${search}` : '/' } as unknown as H3Event
}

describe('/internal/sec/earnings-release', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'AMZN' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('requires a symbol', async () => {
    await expect(handler(makeEvent(AUTH, {}))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('returns the release as the lib produced it', async () => {
    getLatestEarningsRelease.mockResolvedValue({ status: 'ok', exhibit_url: 'https://www.sec.gov/x.htm', text: 'AWS' })
    const r = (await handler(makeEvent(AUTH, { symbol: 'US.AMZN' }))) as { status: string; exhibit_url: string }
    expect(getLatestEarningsRelease).toHaveBeenCalledWith('US.AMZN')
    expect(r.status).toBe('ok')
    expect(r.exhibit_url).toBe('https://www.sec.gov/x.htm')
  })

  it('turns an SEC outage into a 502 the toolkit can report', async () => {
    getLatestEarningsRelease.mockRejectedValue(new Error('SEC 503'))
    await expect(handler(makeEvent(AUTH, { symbol: 'AMZN' }))).rejects.toMatchObject({ statusCode: 502 })
  })
})
