import { and, asc, desc, eq, lte } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { reminders } from '../../db/schema'
import { getNotificationSettings } from './notification-settings'
import { appPublicUrl, enqueueNotification } from './notifications'
import { reminderMessage } from './notifications-messages'
import { shapeReminderRow, type Reminder, type ReminderStatus } from './reminders-core'

export type { Reminder, ReminderStatus }

const LIST_LIMIT = 100

export interface CreateReminderInput {
  dueAt: Date
  message: string
  symbol?: string | null
}

export async function createReminder(input: CreateReminderInput): Promise<Reminder> {
  const inserted = await getDb()
    .insert(reminders)
    .values({ dueAt: input.dueAt, message: input.message, symbol: input.symbol ?? null })
    .returning()
  if (!inserted[0]) throw new Error('failed to create reminder')
  return shapeReminderRow(inserted[0])
}

/** Scheduled reminders soonest-first; any other filter newest-first. */
export async function listReminders(opts: { status?: ReminderStatus } = {}): Promise<Reminder[]> {
  const rows = await getDb()
    .select()
    .from(reminders)
    .where(opts.status ? eq(reminders.status, opts.status) : undefined)
    .orderBy(opts.status === 'scheduled' ? asc(reminders.dueAt) : desc(reminders.dueAt))
    .limit(LIST_LIMIT)
  return rows.map(shapeReminderRow)
}

/** Cancel a scheduled reminder. Null when the id doesn't exist or already fired. */
export async function cancelReminder(id: string): Promise<Reminder | null> {
  const updated = await getDb()
    .update(reminders)
    .set({ status: 'cancelled' })
    .where(and(eq(reminders.id, id), eq(reminders.status, 'scheduled')))
    .returning()
  return updated[0] ? shapeReminderRow(updated[0]) : null
}

/**
 * Flip every due reminder to sent and enqueue its notification in the same
 * transaction: a crash leaves both undone (next tick retries), never a sent
 * reminder with no notification. The status guard means a cancel that wins
 * the race is never sent.
 */
export async function dispatchDueReminders(now = new Date()): Promise<Reminder[]> {
  const { timezone } = await getNotificationSettings()
  const appUrl = appPublicUrl()
  return getDb().transaction(async (tx) => {
    const due = await tx
      .update(reminders)
      .set({ status: 'sent', sentAt: now })
      .where(and(eq(reminders.status, 'scheduled'), lte(reminders.dueAt, now)))
      .returning()
    const shaped = due.map(shapeReminderRow)
    for (const r of shaped) await enqueueNotification(reminderMessage(r, timezone, appUrl), tx)
    return shaped
  })
}
