import type { SQL } from 'drizzle-orm'
import { getTableName, type Table } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'

const dialect = new PgDialect()

export interface RecordedInsert { table: string; values: Record<string, unknown> }
export interface RecordedUpdate { table: string; set: Record<string, unknown>; where: string; params: unknown[] }

export interface FakeDbOptions {
  /** Rows an `insert(...).values(...).returning()` resolves to; may throw to simulate a constraint violation. */
  insertReturning?: (table: string, values: Record<string, unknown>) => unknown[]
  /** Rows an `update(...).set(...).where(...).returning()` resolves to. */
  updateReturning?: (update: RecordedUpdate) => unknown[]
}

/** A promise that also offers drizzle's `.returning()`. */
function returnable(run: () => unknown[]) {
  return {
    then<R>(resolve: (v: undefined) => R, reject?: (e: unknown) => R) {
      return Promise.resolve().then(() => { run() }).then(() => resolve(undefined), reject)
    },
    returning() { return Promise.resolve().then(run) },
  }
}

/** Records drizzle writes; `selectRows` answers every select chain. */
export function createFakeDb(selectRows: (table: string) => unknown[] = () => [], opts: FakeDbOptions = {}) {
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
          const table = getTableName(t)
          inserts.push({ table, values })
          return returnable(() => opts.insertReturning?.(table, values) ?? [])
        },
      }
    },
    update(t: Table) {
      return {
        set(set: Record<string, unknown>) {
          return {
            where(w: SQL) {
              const q = dialect.sqlToQuery(w)
              const recorded = { table: getTableName(t), set, where: q.sql, params: q.params }
              updates.push(recorded)
              return returnable(() => opts.updateReturning?.(recorded) ?? [])
            },
          }
        },
      }
    },
    select() { return selectChain() },
  }
  return { db, inserts, updates }
}
