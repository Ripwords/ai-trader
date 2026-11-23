import { and, asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../db/client'
import { chatMemories } from '../../db/schema'
import { MEMORY_LIMIT, type MemorySource, type MemoryView } from '../../types/memory'
import { memoryKey, type MemoryWrite } from './chat-memory-plan'

export type MemoryWriteResult =
  | { memory: MemoryView }
  | { error: 'full' | 'duplicate' | 'not_found' }

const isUuid = (id: string) => z.string().uuid().safeParse(id).success

function toView(row: typeof chatMemories.$inferSelect): MemoryView {
  return {
    id: row.id,
    content: row.content,
    source: row.source === 'manual' ? 'manual' : 'auto',
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Oldest first, so a memory keeps its place in the list and in the prompt. */
export async function listMemories(userId: string): Promise<MemoryView[]> {
  const rows = await getDb()
    .select()
    .from(chatMemories)
    .where(eq(chatMemories.userId, userId))
    .orderBy(asc(chatMemories.createdAt), asc(chatMemories.id))
  return rows.map(toView)
}

/** `content` is already normalised by `memoryContentSchema`. */
export async function addMemory(userId: string, content: string, source: MemorySource): Promise<MemoryWriteResult> {
  const saved = await listMemories(userId)
  if (saved.some(m => memoryKey(m.content) === memoryKey(content))) return { error: 'duplicate' }
  if (saved.length >= MEMORY_LIMIT) return { error: 'full' }
  const [row] = await getDb().insert(chatMemories).values({ userId, content, source }).returning()
  if (!row) throw new Error('memory insert returned no row')
  return { memory: toView(row) }
}

export async function updateMemory(userId: string, id: string, content: string, source: MemorySource): Promise<MemoryWriteResult> {
  if (!isUuid(id)) return { error: 'not_found' }
  const saved = await listMemories(userId)
  if (saved.some(m => m.id !== id && memoryKey(m.content) === memoryKey(content))) return { error: 'duplicate' }
  const [row] = await getDb()
    .update(chatMemories)
    .set({ content, source, updatedAt: new Date() })
    .where(and(eq(chatMemories.userId, userId), eq(chatMemories.id, id)))
    .returning()
  return row ? { memory: toView(row) } : { error: 'not_found' }
}

export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const gone = await getDb()
    .delete(chatMemories)
    .where(and(eq(chatMemories.userId, userId), eq(chatMemories.id, id)))
    .returning({ id: chatMemories.id })
  return gone.length > 0
}

/** Writes already checked against the list by `planMemoryWrites`. */
export async function applyMemoryWrites(userId: string, writes: readonly MemoryWrite[], source: MemorySource): Promise<void> {
  const db = getDb()
  // One statement each, not one transaction: rows inserted in a transaction
  // share its now() and would lose their order.
  for (const write of writes) {
    if (write.kind === 'insert') {
      await db.insert(chatMemories).values({ userId, content: write.content, source })
    }
    else {
      await db
        .update(chatMemories)
        .set({ content: write.content, source, updatedAt: new Date() })
        .where(and(eq(chatMemories.userId, userId), eq(chatMemories.id, write.id)))
    }
  }
}
