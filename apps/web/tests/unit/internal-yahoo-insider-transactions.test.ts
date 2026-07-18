import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => {
  const iso = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
  return {
    getInsiderTrades: vi.fn().mockResolvedValue([
      { date: iso(5), insider_name: 'Recent', transaction_type: 'sell', shares: 1000, value: 50000 },
      { date: iso(100), insider_name: 'Mid', transaction_type: 'buy', shares: 500, value: 25000 },
      { date: '2023-01-15', insider_name: 'Ancient', transaction_type: 'sell', shares: 200, value: 9000 },
    ]),
  }
})

type Handler = (event: H3Event) => unknown
let handler: Handler
beforeEach(async () => {
  vi.resetModules()
  process.env.INTERNAL_BEARER = 'test-bearer'
  const mod = await import('../../server/api/internal/yahoo/insider-transactions.get')
  handler = mod.default as Handler
})

function makeEvent(headers: Record<string, string>, query: Record<string, string>): H3Event {
  const search = new URLSearchParams(query).toString()
  const path = search ? `/?${search}` : '/'
  return { node: { req: { headers } }, context: {}, path } as unknown as H3Event
}

const auth = { authorization: 'Bearer test-bearer' }

interface InsiderResult {
  symbol: string
  transactions: { insider_name: string; transaction_type: string }[]
}

describe('/internal/yahoo/insider-transactions', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns all insider transactions when no days window given', async () => {
    const result = (await handler(makeEvent(auth, { symbol: 'NVDA' }))) as InsiderResult
    expect(result.symbol).toBe('NVDA')
    expect(result.transactions).toHaveLength(3)
    expect(result.transactions[0].transaction_type).toBe('sell')
  })

  it('filters transactions older than the days window', async () => {
    const result = (await handler(makeEvent(auth, { symbol: 'NVDA', days: '30' }))) as InsiderResult
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].insider_name).toBe('Recent')
  })

  it('caps the days window at 365', async () => {
    const result = (await handler(makeEvent(auth, { symbol: 'NVDA', days: '99999' }))) as InsiderResult
    // Cap → 365-day cutoff: keeps the 5d and 100d rows, drops the 2023 one.
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions.map(t => t.insider_name)).toEqual(['Recent', 'Mid'])
  })

  it('ignores a non-numeric days value', async () => {
    const result = (await handler(makeEvent(auth, { symbol: 'NVDA', days: 'abc' }))) as InsiderResult
    expect(result.transactions).toHaveLength(3)
  })
})
