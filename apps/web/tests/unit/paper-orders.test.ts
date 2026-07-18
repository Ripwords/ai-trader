import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordPaperOrder } from '../../server/lib/paper-orders'

const dbMock = vi.hoisted(() => ({
  values: vi.fn(async () => undefined),
  insert: vi.fn(),
  getDb: vi.fn(),
}))

vi.mock('../../db/client', () => ({
  getDb: dbMock.getDb,
}))

beforeEach(() => {
  dbMock.values.mockClear()
  dbMock.insert.mockReset()
  dbMock.insert.mockReturnValue({ values: dbMock.values })
  dbMock.getDb.mockReset()
  dbMock.getDb.mockReturnValue({ insert: dbMock.insert })
})

describe('recordPaperOrder', () => {
  it('inserts a ledger row with normalized nullables', async () => {
    const ok = await recordPaperOrder({
      source: 'chat',
      moomooOrderId: 'ord-1',
      accId: '123',
      symbol: 'US.NVDA',
      side: 'BUY',
      qty: 5,
      price: 100.5,
      orderType: 'NORMAL',
      trdEnv: 'SIMULATE',
      status: 'SUBMITTED',
      raw: { order_id: 'ord-1' },
    })
    expect(ok).toBe(true)
    expect(dbMock.values).toHaveBeenCalledWith({
      source: 'chat',
      decisionId: null,
      moomooOrderId: 'ord-1',
      accId: '123',
      symbol: 'US.NVDA',
      side: 'BUY',
      qty: 5,
      price: '100.5',
      orderType: 'NORMAL',
      trdEnv: 'SIMULATE',
      status: 'SUBMITTED',
      raw: { order_id: 'ord-1' },
    })
  })

  it('never throws when the insert fails — the order must not be affected', async () => {
    dbMock.values.mockRejectedValueOnce(new Error('db down'))
    const ok = await recordPaperOrder({
      source: 'algo',
      symbol: 'US.AAPL',
      side: 'SELL',
      qty: 1,
    })
    expect(ok).toBe(false)
  })

  it('never throws when the pool itself is unavailable', async () => {
    dbMock.getDb.mockImplementationOnce(() => {
      throw new Error('DATABASE_URL is required')
    })
    await expect(recordPaperOrder({
      source: 'chat',
      symbol: 'US.AAPL',
      side: 'BUY',
      qty: 1,
    })).resolves.toBe(false)
  })
})
