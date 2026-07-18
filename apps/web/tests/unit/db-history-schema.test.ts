import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { paperOrders, portfolioSnapshots } from '../../db/schema'

const NAME = Symbol.for('drizzle:Name')

describe('persistence & history schema', () => {
  it('has the portfolio_snapshots table with totals + jsonb detail columns', () => {
    expect((portfolioSnapshots as unknown as Record<symbol, string>)[NAME]).toBe('portfolio_snapshots')
    const cols = Object.keys(getTableColumns(portfolioSnapshots))
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'capturedAt', 'source', 'currency',
      'netWorth', 'cash', 'positionsValue',
      'perAccount', 'positions', 'resolver',
    ]))
  })

  it('has the paper_orders ledger table with a nullable decision link', () => {
    expect((paperOrders as unknown as Record<symbol, string>)[NAME]).toBe('paper_orders')
    const cols = getTableColumns(paperOrders)
    expect(Object.keys(cols)).toEqual(expect.arrayContaining([
      'id', 'createdAt', 'source', 'decisionId', 'moomooOrderId', 'accId',
      'symbol', 'side', 'qty', 'price', 'orderType', 'trdEnv', 'status', 'raw',
    ]))
    expect(cols.decisionId.notNull).toBe(false)
    expect(cols.symbol.notNull).toBe(true)
    expect(cols.qty.notNull).toBe(true)
  })
})
