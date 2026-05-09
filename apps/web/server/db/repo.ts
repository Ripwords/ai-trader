import { and, asc, desc, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { chatMessages, chatThreads, researchSignals, users, workflowRuns } from '../../db/schema'

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

export interface ResearchSignalInput {
  symbol: string
  source: string
  signal: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  reasoning: string
  metadata?: Record<string, unknown> | null
}

export async function recordResearchSignal(
  userId: string,
  input: ResearchSignalInput,
): Promise<number> {
  const db = getDb()
  const inserted = await db
    .insert(researchSignals)
    .values({
      userId,
      symbol: input.symbol,
      source: input.source,
      signal: input.signal,
      confidence: input.confidence,
      reasoning: input.reasoning,
      metadata: input.metadata ?? null,
    })
    .returning({ id: researchSignals.id })
  if (!inserted[0]) throw new Error('failed to record research signal')
  return inserted[0].id
}

export async function listResearchSignals(
  userId: string,
  opts: { symbol?: string; source?: string; limit?: number } = {},
): Promise<Array<ResearchSignalInput & { id: number; ts: Date }>> {
  const db = getDb()
  const filters = [eq(researchSignals.userId, userId)]
  if (opts.symbol) filters.push(eq(researchSignals.symbol, opts.symbol))
  if (opts.source) filters.push(eq(researchSignals.source, opts.source))
  const rows = await db
    .select({
      id: researchSignals.id,
      symbol: researchSignals.symbol,
      source: researchSignals.source,
      signal: researchSignals.signal,
      confidence: researchSignals.confidence,
      reasoning: researchSignals.reasoning,
      metadata: researchSignals.metadata,
      ts: researchSignals.ts,
    })
    .from(researchSignals)
    .where(and(...filters))
    .orderBy(desc(researchSignals.ts))
    .limit(opts.limit ?? 100)
  return rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    source: r.source,
    signal: r.signal as 'bullish' | 'bearish' | 'neutral',
    confidence: r.confidence,
    reasoning: r.reasoning,
    metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    ts: r.ts,
  }))
}

export interface WorkflowRunStep {
  id: string
  status: string
  ms: number
  error?: string
}

export interface WorkflowRunInput {
  workflowId: string
  inputSummary: Record<string, unknown>
  status: 'success' | 'failed'
  totalMs: number
  steps: WorkflowRunStep[]
  errorMessage?: string | null
}

export interface WorkflowRunRow {
  id: number
  workflowId: string
  inputSummary: Record<string, unknown>
  status: 'success' | 'failed'
  totalMs: number
  steps: WorkflowRunStep[]
  errorMessage: string | null
  startedAt: Date
}

export async function recordWorkflowRun(
  userId: string,
  input: WorkflowRunInput,
): Promise<number> {
  const db = getDb()
  const inserted = await db
    .insert(workflowRuns)
    .values({
      userId,
      workflowId: input.workflowId,
      inputSummary: input.inputSummary,
      status: input.status,
      totalMs: input.totalMs,
      steps: input.steps,
      errorMessage: input.errorMessage ?? null,
    })
    .returning({ id: workflowRuns.id })
  if (!inserted[0]) throw new Error('failed to record workflow run')
  return inserted[0].id
}

export async function listWorkflowRuns(
  userId: string,
  opts: { workflowId?: string; symbol?: string; limit?: number } = {},
): Promise<WorkflowRunRow[]> {
  const db = getDb()
  const filters = [eq(workflowRuns.userId, userId)]
  if (opts.workflowId) filters.push(eq(workflowRuns.workflowId, opts.workflowId))
  const rows = await db
    .select({
      id: workflowRuns.id,
      workflowId: workflowRuns.workflowId,
      inputSummary: workflowRuns.inputSummary,
      status: workflowRuns.status,
      totalMs: workflowRuns.totalMs,
      steps: workflowRuns.steps,
      errorMessage: workflowRuns.errorMessage,
      startedAt: workflowRuns.startedAt,
    })
    .from(workflowRuns)
    .where(and(...filters))
    .orderBy(desc(workflowRuns.startedAt))
    .limit(opts.limit ?? 50)

  const mapped = rows.map((r): WorkflowRunRow => ({
    id: r.id,
    workflowId: r.workflowId,
    inputSummary: (r.inputSummary as Record<string, unknown> | null) ?? {},
    status: r.status as 'success' | 'failed',
    totalMs: r.totalMs,
    steps: Array.isArray(r.steps) ? (r.steps as WorkflowRunStep[]) : [],
    errorMessage: r.errorMessage,
    startedAt: r.startedAt,
  }))

  if (opts.symbol) {
    return mapped.filter(r => r.inputSummary.symbol === opts.symbol)
  }
  return mapped
}
