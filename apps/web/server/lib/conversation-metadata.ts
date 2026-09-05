import { eq, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { appSettings } from '../../db/schema'
import {
  normalizeConversationMetadata,
  normalizeConversationMetadataMap,
  type ConversationDecision,
  type ConversationMetadata,
} from './chat-management'

const CONVERSATION_METADATA_KEY = 'chat_thread_metadata'

function nowIso(): string {
  return new Date().toISOString()
}

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `decision-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * Write one thread's entry with jsonb_set inside the single settings row, so
 * a pin racing an auto-summary on another thread cannot overwrite it with a
 * stale copy of the whole map (which the read-modify-write of the full blob
 * used to do). The row is created empty on first use.
 */
async function saveConversationMetadata(threadId: string, next: ConversationMetadata): Promise<void> {
  const db = getDb()
  await db
    .insert(appSettings)
    .values({ key: CONVERSATION_METADATA_KEY, value: {}, updatedAt: new Date() })
    .onConflictDoNothing({ target: appSettings.key })
  await db
    .update(appSettings)
    .set({
      value: sql`jsonb_set(coalesce(${appSettings.value}, '{}'::jsonb), ${sql.raw(`'{${threadId.replace(/[^a-zA-Z0-9_-]/g, '')}}'`)}, ${JSON.stringify(next)}::jsonb, true)`,
      updatedAt: new Date(),
    })
    .where(eq(appSettings.key, CONVERSATION_METADATA_KEY))
}

export async function getConversationMetadataMap(): Promise<Record<string, ConversationMetadata>> {
  const db = getDb()
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, CONVERSATION_METADATA_KEY))
    .limit(1)
  return normalizeConversationMetadataMap(rows[0]?.value)
}

export async function getConversationMetadata(threadId: string): Promise<ConversationMetadata> {
  const map = await getConversationMetadataMap()
  return map[threadId] ?? normalizeConversationMetadata({})
}

export async function patchConversationMetadata(
  threadId: string,
  patch: { pinned?: unknown; archived?: unknown; summary?: unknown },
): Promise<ConversationMetadata> {
  const map = await getConversationMetadataMap()
  const current = map[threadId] ?? normalizeConversationMetadata({})
  const next: ConversationMetadata = { ...current, decisions: [...current.decisions] }

  if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned
  if (typeof patch.archived === 'boolean') {
    next.archived = patch.archived
    if (patch.archived) next.pinned = false
  }
  if (typeof patch.summary === 'string') next.summary = patch.summary.trim().replace(/\s+/g, ' ') || undefined
  else if (patch.summary === null) next.summary = undefined

  await saveConversationMetadata(threadId, next)
  return next
}

export async function recordConversationDecision(
  threadId: string,
  input: { title: string; note?: string },
): Promise<ConversationMetadata> {
  const title = input.title.trim().replace(/\s+/g, ' ')
  if (!title) throw new Error('decision title required')
  const map = await getConversationMetadataMap()
  const current = map[threadId] ?? normalizeConversationMetadata({})
  const decision: ConversationDecision = {
    id: makeId(),
    title,
    note: input.note?.trim().replace(/\s+/g, ' ') || undefined,
    created_at: nowIso(),
  }
  const next: ConversationMetadata = {
    ...current,
    decisions: [decision, ...current.decisions].slice(0, 50),
  }
  await saveConversationMetadata(threadId, next)
  return next
}
