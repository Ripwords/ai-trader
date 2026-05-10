import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../server/lib/yahoo', () => ({
  getInsiderTrades: vi.fn().mockResolvedValue([
    { date: '2024-09-01', insider_name: 'Doe', transaction_type: 'sell', shares: 1000, value: 50000 },
  ]),
}))

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

describe('/internal/yahoo/insider-transactions', () => {
  it('rejects without bearer', async () => {
    await expect(handler(makeEvent({}, { symbol: 'NVDA' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns insider transactions on bearer match', async () => {
    const event = makeEvent({ authorization: 'Bearer test-bearer' }, { symbol: 'NVDA' })
    const result = (await handler(event)) as {
      symbol: string
      transactions: { transaction_type: string }[]
    }
    expect(result.symbol).toBe('NVDA')
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0].transaction_type).toBe('sell')
  })
})
