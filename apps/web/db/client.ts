import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

let _pool: Pool | undefined
let _db: ReturnType<typeof drizzle> | undefined

export function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is required')
    _pool = new Pool({ connectionString: url })
    _db = drizzle(_pool)
  }
  return _db
}
