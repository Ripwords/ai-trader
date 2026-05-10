import { and, asc, desc, eq, gte, sql } from 'drizzle-orm'
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
  messages: Array<{ id?: string; role: string; parts?: unknown[]; [k: string]: unknown }>,
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
  estimatedCostUsd: number
}

export interface LlmUsageRow {
  id: number
  source: string
  modelSpec: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number
  ts: Date
}

export interface LlmUsageBreakdownRow {
  source: string
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

export interface LlmUsageSummary {
  totals: {
    today: { calls: number; totalTokens: number; estimatedCostUsd: number }
    week: { calls: number; totalTokens: number; estimatedCostUsd: number }
    month: { calls: number; totalTokens: number; estimatedCostUsd: number }
    allTime: { calls: number; totalTokens: number; estimatedCostUsd: number }
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
      estimatedCostUsd: input.estimatedCostUsd.toString(),
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
    estimatedCostUsd: Number(r.estimatedCostUsd),
    ts: r.ts,
  }))
}

export async function getLlmUsageSummary(userId: string): Promise<LlmUsageSummary> {
  const db = getDb()
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  async function totalsSince(since: Date | null) {
    const filters = [eq(llmUsage.userId, userId)]
    if (since) filters.push(gte(llmUsage.ts, since))
    const rows = await db
      .select({
        calls: sql<number>`count(*)::int`,
        totalTokens: sql<number>`coalesce(sum(${llmUsage.totalTokens}), 0)::int`,
        estimatedCostUsd: sql<string>`coalesce(sum(${llmUsage.estimatedCostUsd}), 0)::text`,
      })
      .from(llmUsage)
      .where(and(...filters))
    const r = rows[0]
    return {
      calls: Number(r?.calls ?? 0),
      totalTokens: Number(r?.totalTokens ?? 0),
      estimatedCostUsd: Number(r?.estimatedCostUsd ?? 0),
    }
  }

  const [today, week, month, allTime] = await Promise.all([
    totalsSince(startOfDay),
    totalsSince(sevenDaysAgo),
    totalsSince(thirtyDaysAgo),
    totalsSince(null),
  ])

  const breakdown = await db
    .select({
      source: llmUsage.source,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${llmUsage.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${llmUsage.outputTokens}), 0)::int`,
      totalTokens: sql<number>`coalesce(sum(${llmUsage.totalTokens}), 0)::int`,
      estimatedCostUsd: sql<string>`coalesce(sum(${llmUsage.estimatedCostUsd}), 0)::text`,
    })
    .from(llmUsage)
    .where(and(eq(llmUsage.userId, userId), gte(llmUsage.ts, thirtyDaysAgo)))
    .groupBy(llmUsage.source)

  const bySource: LlmUsageBreakdownRow[] = breakdown
    .map(r => ({
      source: r.source,
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      totalTokens: Number(r.totalTokens),
      estimatedCostUsd: Number(r.estimatedCostUsd),
    }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)

  return {
    totals: { today, week, month, allTime },
    bySource,
  }
}
