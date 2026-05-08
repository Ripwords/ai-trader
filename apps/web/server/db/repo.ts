import { and, asc, desc, eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { chatMessages, chatThreads, users } from '../../db/schema'

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
