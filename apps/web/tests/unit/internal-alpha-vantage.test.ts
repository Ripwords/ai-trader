import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getEarningsCallTranscript = vi.fn()
const getEstimateRevisions = vi.fn()
vi.mock('../../server/lib/alpha-vantage', () => ({
  getEarningsCallTranscript: (...a: unknown[]) => getEarningsCallTranscript(...a),
  getEstimateRevisions: (...a: unknown[]) => getEstimateRevisions(...a),
}))

type Handler = (event: H3Event) => unknown
let transcript: Handler
let estimates: Handler
const AUTH = { authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }

beforeEach(async () => {
  vi.resetModules()
  getEarningsCallTranscript.mockReset()
  getEstimateRevisions.mockReset()
  process.env.INTERNAL_BEARER = 'test-bearer-0123456789abcdef0123456789'
  transcript = (await import('../../server/api/internal/alpha-vantage/transcript.get')).default as Handler
  estimates = (await import('../../server/api/internal/alpha-vantage/estimates.get')).default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  return { node: { req: { headers } }, context: {}, path: search ? `/?${search}` : '/' } as unknown as H3Event
}

describe('/internal/alpha-vantage/*', () => {
  it('rejects without bearer', async () => {
    await expect(transcript(makeEvent({}, { symbol: 'AMZN' }))).rejects.toMatchObject({ statusCode: 401 })
    await expect(estimates(makeEvent({}, { symbol: 'AMZN' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('requires a symbol', async () => {
    await expect(transcript(makeEvent(AUTH, {}))).rejects.toMatchObject({ statusCode: 400 })
    await expect(estimates(makeEvent(AUTH, {}))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('passes the quarter through, or undefined for the latest', async () => {
    getEarningsCallTranscript.mockResolvedValue({ status: 'ok' })
    await transcript(makeEvent(AUTH, { symbol: 'AMZN', quarter: '2026Q2' }))
    await transcript(makeEvent(AUTH, { symbol: 'AMZN' }))
    expect(getEarningsCallTranscript.mock.calls).toEqual([['AMZN', '2026Q2'], ['AMZN', undefined]])
  })

  it('returns an unavailable result as-is with its quota', async () => {
    const r = { status: 'unavailable', reason: 'quota_exhausted', quota: { remaining: 0 } }
    getEstimateRevisions.mockResolvedValue(r)
    expect(await estimates(makeEvent(AUTH, { symbol: 'AMZN' }))).toEqual(r)
  })
})
