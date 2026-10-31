import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  getFundamentalsBundle: vi.fn().mockResolvedValue({
    symbol: 'NVDA',
    metrics: { symbol: 'NVDA', pe_ratio: 50 },
    history: [{ period: '2024' }],
    balance_sheet: null,
    cashflow: null,
    income_statement: null,
  }),
}))

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  process.env.INTERNAL_BEARER = 'test-bearer-0123456789abcdef0123456789'
  const mod = await import('../../server/api/internal/yahoo/fundamentals.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: { headers } }, context: {}, path } as unknown as H3Event
}

describe('/internal/yahoo/fundamentals', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns full bundle on bearer match', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as { symbol: string; metrics: { pe_ratio: number } }
    expect(result.symbol).toBe('NVDA')
    expect(result.metrics.pe_ratio).toBe(50)
  })

  it('does not cache an empty bundle, so a failed Yahoo fetch is retried', async () => {
    const yahoo = await import('../../server/lib/yahoo')
    const bundle = vi.mocked(yahoo.getFundamentalsBundle)
    const calls = bundle.mock.calls.length
    bundle.mockResolvedValueOnce({ symbol: 'NVDA', history: [], balance_sheet: null } as Awaited<ReturnType<typeof yahoo.getFundamentalsBundle>>)
    const auth = { authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }
    await handler(makeEvent(auth, { symbol: 'NVDA' }))
    await handler(makeEvent(auth, { symbol: 'NVDA' }))
    expect(bundle.mock.calls.length - calls).toBe(2)
  })

  it('caches a bundle with history', async () => {
    const yahoo = await import('../../server/lib/yahoo')
    const bundle = vi.mocked(yahoo.getFundamentalsBundle)
    const calls = bundle.mock.calls.length
    const auth = { authorization: 'Bearer test-bearer-0123456789abcdef0123456789' }
    await handler(makeEvent(auth, { symbol: 'CACHED' }))
    await handler(makeEvent(auth, { symbol: 'CACHED' }))
    expect(bundle.mock.calls.length - calls).toBe(1)
  })
})
