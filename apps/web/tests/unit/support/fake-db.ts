import type { SQL } from 'drizzle-orm'
import { getTableName, type Table } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

const dialect = new PgDialect()

export interface RecordedInsert { table: string; values: Record<string, unknown> }
export interface RecordedUpdate { table: string; set: Record<string, unknown>; where: string; params: unknown[] }

/** Records drizzle writes; `selectRows` answers every select chain. */
export function createFakeDb(selectRows: (table: string) => unknown[] = () => []) {
  const inserts: RecordedInsert[] = []
  const updates: RecordedUpdate[] = []

  function selectChain() {
    let table = ''
    const chain = {
      from(t: Table) { table = getTableName(t); return chain },
      where() { return chain },
      orderBy() { return chain },
      limit() { return chain },
      then<R>(resolve: (rows: unknown[]) => R) { return Promise.resolve(selectRows(table)).then(resolve) },
    }
    return chain
  }

  const db = {
    insert(t: Table) {
      return {
        values(values: Record<string, unknown>) {
          inserts.push({ table: getTableName(t), values })
          return Promise.resolve()
        },
      }
    },
    update(t: Table) {
      return {
        set(set: Record<string, unknown>) {
          return {
            where(w: SQL) {
              const q = dialect.sqlToQuery(w)
              updates.push({ table: getTableName(t), set, where: q.sql, params: q.params })
              return Promise.resolve()
            },
          }
        },
      }
    },
    select() { return selectChain() },
  }
  return { db, inserts, updates }
}
