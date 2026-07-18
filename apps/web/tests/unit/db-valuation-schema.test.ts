import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { valuationSnapshots } from '../../db/schema'

const NAME = Symbol.for('drizzle:Name')

describe('valuation_snapshots schema', () => {
  it('has the expected table name and columns', () => {
    expect((valuationSnapshots as unknown as Record<symbol, string>)[NAME]).toBe('valuation_snapshots')
    const cols = Object.keys(getTableColumns(valuationSnapshots))
    expect(cols).toEqual(expect.arrayContaining([
      'id',
      'createdAt',
      'symbol',
      'source',
      'runId',
      'fairValue',
      'currentPrice',
      'marginOfSafetyPct',
      'dataQuality',
      'vetoTriggered',
      'result',
    ]))
  })

  it('allows nullable fair value / run id and defaults vetoTriggered to false', () => {
    const cols = getTableColumns(valuationSnapshots)
    expect(cols.runId.notNull).toBe(false)
    expect(cols.fairValue.notNull).toBe(false)
    expect(cols.marginOfSafetyPct.notNull).toBe(false)
    expect(cols.currentPrice.notNull).toBe(true)
    expect(cols.dataQuality.notNull).toBe(true)
    expect(cols.vetoTriggered.notNull).toBe(true)
    expect(cols.vetoTriggered.default).toBe(false)
    expect(cols.result.notNull).toBe(true)
  })
})
