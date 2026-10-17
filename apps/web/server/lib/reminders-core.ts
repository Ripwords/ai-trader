/**
 * Time-based reminders — pure core: wire shape, row shaping and due-time
 * validation. The DB half lives in ./reminders.ts.
 */
import { z } from 'zod'

export const REMINDER_STATUSES = ['scheduled', 'sent', 'cancelled'] as const
export type ReminderStatus = typeof REMINDER_STATUSES[number]

/** Wire/API shape (dates ISO strings). */
export interface Reminder {
  id: string
  createdAt: string
  dueAt: string
  message: string
  symbol: string | null
  status: ReminderStatus
  sentAt: string | null
}

export interface ReminderDbRow {
  id: string
  createdAt: Date
  dueAt: Date
  message: string
  symbol: string | null
  status: string
  sentAt: Date | null
}

export function shapeReminderRow(row: ReminderDbRow): Reminder {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    message: row.message,
    symbol: row.symbol,
    status: row.status as ReminderStatus,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
  }
}

export const REMINDER_MESSAGE_MAX = 500

/** POST /api/reminders and the reminder_create tool. `dueAt` must carry its UTC offset. */
export const reminderCreateSchema = z.object({
  dueAt: z.string().datetime({ offset: true }),
  message: z.string().trim().min(1).max(REMINDER_MESSAGE_MAX),
  symbol: z.string().trim().min(1).max(32).nullish(),
})

/** A minute of slack lets "remind me now" through despite clock skew and typing time. */
const PAST_SLACK_MS = 60_000
const MAX_AHEAD_MS = 366 * 24 * 60 * 60_000

/** Why `dueAt` can't be scheduled, or null when it can. */
export function dueAtProblem(dueAt: Date, now: Date): string | null {
  if (Number.isNaN(dueAt.getTime())) return 'due time is not a valid date'
  if (dueAt.getTime() < now.getTime() - PAST_SLACK_MS) return 'due time is in the past'
  if (dueAt.getTime() > now.getTime() + MAX_AHEAD_MS) return 'due time is more than a year away'
  return null
}
