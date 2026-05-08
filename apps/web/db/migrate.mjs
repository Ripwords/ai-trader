// Programmatic migrator. Replaces `drizzle-kit migrate` CLI which hangs in
// non-TTY (no progress spinner) inside the docker run.
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

const { Pool } = pg

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const pool = new Pool({ connectionString: url })
const db = drizzle(pool)

try {
  await migrate(db, { migrationsFolder: './db/migrations' })
  console.log('migrations applied')
} catch (err) {
  console.error('migration failed:', err)
  process.exit(1)
} finally {
  await pool.end()
}
