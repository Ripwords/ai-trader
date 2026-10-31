import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

let _pool: Pool | undefined
let _db: ReturnType<typeof drizzle> | undefined

export function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is required')
    // Without limits a call that never returns (pool exhausted, a half-open
    // socket after Postgres restarts) blocked its caller for good. The
    // notification sender joins one shared drain, so one such call stopped
    // all sending until the container restarted.
    _pool = new Pool({
      connectionString: url,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 60_000,
      query_timeout: 65_000,
      keepAlive: true,
    })
    _db = drizzle(_pool)
  }
  return _db
}
