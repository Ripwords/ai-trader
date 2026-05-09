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
  code: text('code').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  // Backtest configuration — also used by the live scheduler for sizing.
  initialCapital: numeric('initial_capital', { precision: 18, scale: 2 }).notNull().default('100000'),
  commissionBps: integer('commission_bps').notNull().default(10),
  slippageBps: integer('slippage_bps').notNull().default(5),
  sizingMode: varchar('sizing_mode', { length: 16 }).notNull().default('fixed_qty'),
  sizingValue: numeric('sizing_value', { precision: 18, scale: 4 }).notNull().default('1'),
  pyramidingMax: integer('pyramiding_max').notNull().default(1),
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
  equityCurve: jsonb('equity_curve'),
  benchmarkCurve: jsonb('benchmark_curve'),
  priceBars: jsonb('price_bars'),
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

// Research signals emitted by analyst agents and LLM personas (Buffett,
// Lynch, etc.). Keyed by user + symbol + source so the /research page can
// show a per-symbol breakdown and synthesize_decisions can aggregate.
export const researchSignals = pgTable('research_signals', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  symbol: varchar('symbol', { length: 32 }).notNull(),
  source: varchar('source', { length: 64 }).notNull(),
  signal: varchar('signal', { length: 16 }).notNull(),
  confidence: integer('confidence').notNull(),
  reasoning: text('reasoning').notNull(),
  metadata: jsonb('metadata'),
  ts: timestamp('ts').defaultNow().notNull(),
})

// Mastra workflow runs — observability for analyze-ticker (and future
// workflows). `steps` is the per-step timing breakdown inspected from
// `result.steps` so /research/runs can show why a slow run was slow.
export const workflowRuns = pgTable('workflow_runs', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workflowId: varchar('workflow_id', { length: 64 }).notNull(),
  inputSummary: jsonb('input_summary').notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  totalMs: integer('total_ms').notNull(),
  steps: jsonb('steps').notNull(),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at').defaultNow().notNull(),
})

// Per-call LLM token usage + estimated USD cost. One row per chat turn or
// persona generateObject call. `source` distinguishes 'chat' from
// 'persona:<id>'. `modelSpec` is the LLM_MODEL spec string at call time.
export const llmUsage = pgTable('llm_usage', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  source: varchar('source', { length: 64 }).notNull(),
  modelSpec: varchar('model_spec', { length: 64 }).notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  totalTokens: integer('total_tokens').notNull(),
  estimatedCostUsd: numeric('estimated_cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  ts: timestamp('ts').defaultNow().notNull(),
})
