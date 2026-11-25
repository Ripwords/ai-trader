import { describe, expect, it } from 'vitest'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { orderProposals } from '../../db/schema'

describe('order_proposals schema', () => {
  it('holds the whole order plus where it came from and what became of it', () => {
    expect(getTableName(orderProposals)).toBe('order_proposals')
    expect(Object.keys(getTableColumns(orderProposals))).toEqual(expect.arrayContaining([
      'id', 'createdAt', 'expiresAt', 'source', 'decisionId', 'algoStrategyId',
      'accId', 'trdEnv', 'symbol', 'side', 'qty', 'orderType', 'price', 'triggerPrice',
      'trailType', 'trailValue', 'trailSpread', 'timeInForce', 'session',
      'rationale', 'status', 'moomooOrderId', 'error', 'decidedAt',
    ]))
  })

  it('starts pending as a DAY, regular-hours limit order', () => {
    const cols = getTableColumns(orderProposals)
    expect(cols.status.default).toBe('pending')
    expect(cols.orderType.default).toBe('NORMAL')
    expect(cols.timeInForce.default).toBe('DAY')
    expect(cols.session.default).toBe('RTH')
    expect(cols.expiresAt.notNull).toBe(true)
    expect(cols.expiresAt.hasDefault).toBe(true)
  })

  it('lets a paper proposal leave the account to the api', () => {
    expect(getTableColumns(orderProposals).accId.notNull).toBe(false)
  })

  it('indexes pending rows only', () => {
    const idx = getTableConfig(orderProposals).indexes.map(i => i.config.name)
    expect(idx).toContain('order_proposals_pending_idx')
  })
})
