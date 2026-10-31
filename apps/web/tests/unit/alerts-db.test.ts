import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// Runs against a real, migrated Postgres. Point TEST_DATABASE_URL at a
// throwaway database.
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('alerts (TEST_DATABASE_URL)', () => {
  let alerts: typeof import('../../server/lib/alerts')
  let db: ReturnType<typeof import('../../db/client')['getDb']>
  let schema: typeof import('../../db/schema')

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    alerts = await import('../../server/lib/alerts')
    db = (await import('../../db/client')).getDb()
    schema = await import('../../db/schema')
  })

  afterEach(async () => {
    await db.delete(schema.priceAlerts)
  })

  it('still lists an old armed alert after more than 100 newer ones have settled, so it can be cancelled from the panel', async () => {
    const old = await alerts.createAlert({ symbol: 'US.OLD', kind: 'price_above', threshold: 1 })
    const settled = Array.from({ length: 101 }, (_, i) => ({
      symbol: `US.S${i}`, kind: 'price_above', threshold: '1', status: 'cancelled',
      createdAt: new Date(Date.now() + (i + 1) * 1000),
    }))
    await db.insert(schema.priceAlerts).values(settled)

    const listed = await alerts.listAlerts()
    expect(listed.map(a => a.id)).toContain(old.id)
    expect(listed.filter(a => a.status !== 'active')).toHaveLength(100)
  })

  it('says why a fired alert cannot be cancelled instead of "not found"', async () => {
    const a = await alerts.createAlert({ symbol: 'US.NVDA', kind: 'price_above', threshold: 100 })
    await db.update(schema.priceAlerts).set({ status: 'triggered', triggeredPrice: '101.5', triggeredAt: new Date() })

    const out = await alerts.cancelAlert(a.id)
    expect(out).toMatchObject({ error: expect.stringMatching(/already triggered at 101\.5/) })
  })

  it('reports an id that is not a uuid as not found, rather than a database error', async () => {
    await expect(alerts.cancelAlert('NVDA')).resolves.toEqual({ error: 'alert not found' })
  })

  it('cancels an active alert', async () => {
    const a = await alerts.createAlert({ symbol: 'US.NVDA', kind: 'price_below', threshold: 100 })
    await expect(alerts.cancelAlert(a.id)).resolves.toMatchObject({ alert: { id: a.id, status: 'cancelled' } })
  })
})
