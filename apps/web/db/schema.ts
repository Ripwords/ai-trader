import { boolean, integer, jsonb, numeric, pgTable, serial, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const appSettings = pgTable('app_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const chatThreads = pgTable('chat_threads', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const chatMessages = pgTable('chat_messages', {
  id: serial('id').primaryKey(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => chatThreads.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 16 }).notNull(),
  content: jsonb('content').notNull(),
  toolCalls: jsonb('tool_calls'),
  reasoning: jsonb('reasoning'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

// Algo trading: strategies, runs, signals.
// `code` is a Python source string executed inside the FastAPI container's
// AST-allowlisted sandbox. `cadence` is one of '1m','5m','15m','1h','1d' —
// the live scheduler's tick interval.
export const algoStrategies = pgTable('algo_strategies', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 128 }).notNull(),
  symbol: varchar('symbol', { length: 32 }).notNull(),
  cadence: varchar('cadence', { length: 8 }).notNull(),
  qtyPerSignal: integer('qty_per_signal').notNull().default(1),
  code: text('code').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

// Backtest or live-tick run record. `kind` = 'backtest' | 'live_signal'.
// `status` = 'pending' | 'running' | 'ok' | 'error'.
export const algoRuns = pgTable('algo_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  strategyId: uuid('strategy_id')
    .notNull()
    .references(() => algoStrategies.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 16 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  // Equity curve as [{ t, v }, ...], trades as [{ ts, side, qty, price, pnl }, ...],
  // metrics as { pnl, win_rate, max_dd, sharpe, n_trades }.
  equityCurve: jsonb('equity_curve'),
  trades: jsonb('trades'),
  metrics: jsonb('metrics'),
  error: text('error'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
  finishedAt: timestamp('finished_at'),
})

// Live signal emitted by the scheduler. `orderId` is the moomoo paper order
// id once the place_order succeeds (null if signal was emitted but order
// rejected).
export const algoSignals = pgTable('algo_signals', {
  id: serial('id').primaryKey(),
  strategyId: uuid('strategy_id')
    .notNull()
    .references(() => algoStrategies.id, { onDelete: 'cascade' }),
  ts: timestamp('ts').defaultNow().notNull(),
  side: varchar('side', { length: 8 }).notNull(),
  qty: integer('qty').notNull(),
  price: numeric('price', { precision: 18, scale: 6 }),
  orderId: varchar('order_id', { length: 64 }),
  error: text('error'),
})
