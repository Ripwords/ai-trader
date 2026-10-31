import { and, asc, desc, eq, gt, gte, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { chatMessages, chatThreads, llmUsage, users } from '../../db/schema'

const SINGLE_USER_NAME = 'owner'

/** Get-or-create the single owner user (we're single-tenant for now). */
export async function getOwnerId(): Promise<string> {
  const db = getDb()
  const found = await db.select().from(users).where(eq(users.name, SINGLE_USER_NAME)).limit(1)
  if (found[0]) return found[0].id
  const inserted = await db.insert(users).values({ name: SINGLE_USER_NAME }).returning({ id: users.id })
  if (!inserted[0]) throw new Error('failed to create owner user')
  return inserted[0].id
}

export async function listThreads(userId: string) {
  const db = getDb()
  return db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
    })
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(50)
}

export async function getThread(userId: string, threadId: string) {
  const db = getDb()
  const rows = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

export async function getThreadMessages(threadId: string) {
  const db = getDb()
  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.id))
  // content is the serialized UIMessage; cast for the route's consumer.
  return rows.map(r => r.content) as Array<{
    id: string
    role: 'user' | 'assistant' | 'system'
    parts?: unknown[]
  }>
}

/**
 * When the thread has saved `message` (matched by id), store it over the saved
 * copy, delete everything saved after it, and return true. A retry resends a
 * saved question, often followed by the reply that failed or was stopped; an
 * edit resends it with new text. Either way the later turns are what the new
 * reply replaces, so they go, and the question is not saved twice.
 */
export async function keepThrough(
  threadId: string,
  message: { id: string; role: string; parts?: readonly unknown[]; metadata?: unknown },
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(eq(chatMessages.threadId, threadId), sql`${chatMessages.content}->>'id' = ${message.id}`))
      .orderBy(desc(chatMessages.id))
      .limit(1)
    if (!row) return false
    await tx.update(chatMessages).set({ content: message }).where(eq(chatMessages.id, row.id))
    await tx.delete(chatMessages).where(and(eq(chatMessages.threadId, threadId), gt(chatMessages.id, row.id)))
    return true
  })
}

export async function createThread(userId: string, title: string): Promise<string> {
  const db = getDb()
  const inserted = await db
    .insert(chatThreads)
    .values({ userId, title })
    .returning({ id: chatThreads.id })
  if (!inserted[0]) throw new Error('failed to create thread')
  return inserted[0].id
}

export async function appendMessages(
  threadId: string,
  messages: ReadonlyArray<{ id?: string; role: string; parts?: readonly unknown[]; metadata?: unknown }>,
): Promise<void> {
  if (messages.length === 0) return
  const db = getDb()
  await db.insert(chatMessages).values(
    messages.map(m => ({
      threadId,
      role: m.role,
      content: m,
    })),
  )
  await db
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, threadId))
}

/** Delete every chat_messages row for a thread, then the thread itself.
 *  Use for the new-chat reset OR explicit delete. */
export async function deleteThread(userId: string, threadId: string): Promise<void> {
  const db = getDb()
  await db
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
}

/** Derive a short, sensible title from the first user message. */
/** Rename a thread only while it still has the title it was created with, so a rename by the user wins. */
export async function retitleThread(threadId: string, from: string, to: string): Promise<boolean> {
  const db = getDb()
  const updated = await db
    .update(chatThreads)
    .set({ title: to })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.title, from)))
    .returning({ id: chatThreads.id })
  return updated.length > 0
}

export function titleFromText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 60) return trimmed
  return trimmed.slice(0, 57) + '…'
}

export interface LlmUsageInput {
  source: string
  modelSpec: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Null when the model has no pricing entry. */
  estimatedCostUsd: number | null
}

export interface LlmUsageRow {
  id: number
  source: string
  modelSpec: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  ts: Date
}

export interface LlmUsageBreakdownRow {
  source: string
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number
  /** Calls with no price (a model missing from the pricing table); not in the cost. */
  unpricedCalls: number
}

export interface LlmUsagePeriod { calls: number; totalTokens: number; estimatedCostUsd: number; unpricedCalls: number }

export interface LlmUsageSummary {
  totals: {
    today: LlmUsagePeriod
    week: LlmUsagePeriod
    month: LlmUsagePeriod
    allTime: LlmUsagePeriod
  }
  bySource: LlmUsageBreakdownRow[]
}

export async function recordLlmUsage(userId: string, input: LlmUsageInput): Promise<number> {
  const db = getDb()
  const inserted = await db
    .insert(llmUsage)
    .values({
      userId,
      source: input.source,
      modelSpec: input.modelSpec,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      estimatedCostUsd: input.estimatedCostUsd?.toString() ?? null,
    })
    .returning({ id: llmUsage.id })
  if (!inserted[0]) throw new Error('failed to record llm usage')
  return inserted[0].id
}

export async function listLlmUsage(
  userId: string,
  opts: { limit?: number; source?: string } = {},
): Promise<LlmUsageRow[]> {
  const db = getDb()
  const filters = [eq(llmUsage.userId, userId)]
  if (opts.source) filters.push(eq(llmUsage.source, opts.source))
  const rows = await db
    .select({
      id: llmUsage.id,
      source: llmUsage.source,
      modelSpec: llmUsage.modelSpec,
      inputTokens: llmUsage.inputTokens,
      outputTokens: llmUsage.outputTokens,
      totalTokens: llmUsage.totalTokens,
      estimatedCostUsd: llmUsage.estimatedCostUsd,
      ts: llmUsage.ts,
    })
    .from(llmUsage)
    .where(and(...filters))
    .orderBy(desc(llmUsage.ts))
    .limit(opts.limit ?? 100)
  return rows.map(r => ({
    id: r.id,
    source: r.source,
    modelSpec: r.modelSpec,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    totalTokens: r.totalTokens,
    estimatedCostUsd: r.estimatedCostUsd == null ? null : Number(r.estimatedCostUsd),
    ts: r.ts,
  }))
}

/**
 * Every metered call: the web app's own (llm_usage) plus finished agents
 * debates, which the api records only on agent_runs. llm_usage.ts is a UTC
 * timestamp without a zone.
 */
function spendFor(userId: string) {
  return sql`(
    select source, input_tokens::bigint as input_tokens, output_tokens::bigint as output_tokens,
      total_tokens::bigint as total_tokens, estimated_cost_usd as cost, ts at time zone 'UTC' as ts
    from llm_usage where user_id = ${userId}
    union all
    select 'agents-debate', coalesce(tokens_in, 0)::bigint, coalesce(tokens_out, 0)::bigint,
      (coalesce(tokens_in, 0) + coalesce(tokens_out, 0))::bigint, cost_usd, started_at
    from agent_runs where user_id = ${userId} and status <> 'running'
  ) as spend`
}

/** Totals for today (from midnight in `timeZone`), 7 and 30 days, and all time, by source over 30 days. */
export async function getLlmUsageSummary(userId: string, timeZone: string): Promise<LlmUsageSummary> {
  const db = getDb()
  const now = Date.now()
  const week = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
  const month = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const today = sql`(date_trunc('day', now() at time zone ${timeZone}) at time zone ${timeZone})`
  const period = (name: string, since: ReturnType<typeof sql> | null) => {
    const where = since ? sql`ts >= ${since}` : sql`true`
    return sql`
      count(*) filter (where ${where}) as ${sql.raw(`${name}_calls`)},
      coalesce(sum(total_tokens) filter (where ${where}), 0)::text as ${sql.raw(`${name}_tokens`)},
      coalesce(sum(cost) filter (where ${where}), 0)::text as ${sql.raw(`${name}_cost`)},
      count(*) filter (where ${where} and cost is null) as ${sql.raw(`${name}_unpriced`)}`
  }
  const totalsResult = await db.execute<Record<string, string | number | null>>(sql`
    select ${period('today', today)}, ${period('week', sql`${week}::timestamptz`)},
      ${period('month', sql`${month}::timestamptz`)}, ${period('all', null)}
    from ${spendFor(userId)}`)
  const t = totalsResult.rows[0] ?? {}
  const pick = (name: string): LlmUsagePeriod => ({
    calls: Number(t[`${name}_calls`] ?? 0),
    totalTokens: Number(t[`${name}_tokens`] ?? 0),
    estimatedCostUsd: Number(t[`${name}_cost`] ?? 0),
    unpricedCalls: Number(t[`${name}_unpriced`] ?? 0),
  })

  const breakdown = await db.execute<Record<string, string | number | null>>(sql`
    select source, count(*) as calls,
      coalesce(sum(input_tokens), 0)::text as input_tokens, coalesce(sum(output_tokens), 0)::text as output_tokens,
      coalesce(sum(total_tokens), 0)::text as total_tokens, coalesce(sum(cost), 0)::text as cost,
      count(*) filter (where cost is null) as unpriced
    from ${spendFor(userId)}
    where ts >= ${month}::timestamptz
    group by source`)
  const bySource: LlmUsageBreakdownRow[] = breakdown.rows
    .map(r => ({
      source: String(r.source),
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      totalTokens: Number(r.total_tokens),
      estimatedCostUsd: Number(r.cost),
      unpricedCalls: Number(r.unpriced),
    }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)

  return {
    totals: { today: pick('today'), week: pick('week'), month: pick('month'), allTime: pick('all') },
    bySource,
  }
}
