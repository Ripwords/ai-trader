import { beforeEach, describe, expect, it, vi } from 'vitest'

const Pool = vi.fn()
vi.mock('pg', () => ({ Pool: class { constructor(opts: unknown) { Pool(opts) } } }))
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: () => ({}) }))

beforeEach(() => {
  vi.resetModules()
  Pool.mockClear()
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db'
})

describe('getDb pool', () => {
  it('bounds connecting and every query, so one hung call cannot stall the notification sender for good', async () => {
    const { getDb } = await import('../../db/client')
    getDb()
    const opts = Pool.mock.calls[0]![0] as Record<string, unknown>
    expect(opts.connectionTimeoutMillis).toBeGreaterThan(0)
    expect(opts.query_timeout).toBeGreaterThan(0)
    expect(opts.statement_timeout).toBeGreaterThan(0)
    expect(opts.keepAlive).toBe(true)
  })
})
