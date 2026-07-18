import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { priceAlerts } from '../../db/schema'

const NAME = Symbol.for('drizzle:Name')

describe('price_alerts schema', () => {
  it('has the expected table name and columns', () => {
    expect((priceAlerts as unknown as Record<symbol, string>)[NAME]).toBe('price_alerts')
    const cols = Object.keys(getTableColumns(priceAlerts))
    expect(cols).toEqual(expect.arrayContaining([
      'id',
      'createdAt',
      'symbol',
      'kind',
      'threshold',
      'note',
      'status',
      'triggeredAt',
      'triggeredPrice',
    ]))
  })

  it('defaults status to active and allows nullable trigger fields', () => {
    const cols = getTableColumns(priceAlerts)
    expect(cols.status.default).toBe('active')
    expect(cols.note.notNull).toBe(false)
    expect(cols.triggeredAt.notNull).toBe(false)
    expect(cols.triggeredPrice.notNull).toBe(false)
  })
})
