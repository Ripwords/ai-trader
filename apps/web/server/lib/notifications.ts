import { and, asc, eq, inArray, lte } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { notifications, pushSubscriptions } from '../../db/schema'
import { emailConfigFromEnv, sendEmail } from './email/resend'
import { getNotificationSettings } from './notification-settings'
import type { DeliveryStatus, NotificationKind } from './notifications-core'
import { dispatchNotifications, type DispatchDeps, type DispatchSummary, type OutboxRow } from './notifications-dispatch'
import type { NotificationMessage } from './notifications-messages'
import { pushConfigFromEnv, sendPush } from './push/web-push'

/**
 * Notifications outbox — DB half. Producers call enqueueNotification (inside
 * their own transaction where they have one); the `notify:send` task calls
 * drainNotifications every minute.
 */

type Db = ReturnType<typeof getDb>
/** getDb() or a transaction handle from it. */
export type Inserter = Pick<Db, 'insert'>

/** Base for absolute links in emails (APP_PUBLIC_URL); null leaves emails link-free. */
export function appPublicUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.APP_PUBLIC_URL?.trim()
  return raw ? raw.replace(/\/+$/, '') : null
}

/** Idempotent on the message's dedupe key. True when a new row was written. */
export async function enqueueNotification(message: NotificationMessage, db: Inserter = getDb()): Promise<boolean> {
  const rows = await db
    .insert(notifications)
    .values({
      kind: message.kind,
      dedupeKey: message.dedupeKey,
      subject: message.subject,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml,
      url: message.url,
      attachments: message.attachments?.length ? message.attachments : null,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id })
  return rows.length > 0
}

/** Enqueue without letting a failure escape into the producer. */
export async function enqueueNotificationSafely(message: NotificationMessage): Promise<void> {
  try {
    await enqueueNotification(message)
  }
  catch (err) {
    console.error('[notify] enqueue failed for', message.dedupeKey, err instanceof Error ? err.message : err)
  }
}

async function claimDue(now: Date, leaseUntil: Date, limit: number): Promise<OutboxRow[]> {
  const db = getDb()
  const due = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.status, 'pending'), lte(notifications.nextAttemptAt, now)))
    .orderBy(asc(notifications.nextAttemptAt))
    .limit(limit)
  const rows = await db
    .update(notifications)
    .set({ nextAttemptAt: leaseUntil })
    .where(and(inArray(notifications.id, due), eq(notifications.status, 'pending'), lte(notifications.nextAttemptAt, now)))
    .returning()
  return rows.map(r => ({
    id: r.id,
    kind: r.kind as NotificationKind,
    dedupeKey: r.dedupeKey,
    subject: r.subject,
    bodyText: r.bodyText,
    bodyHtml: r.bodyHtml,
    url: r.url,
    attachments: r.attachments,
    emailStatus: r.emailStatus as DeliveryStatus,
    pushStatus: r.pushStatus as DeliveryStatus,
    attempts: r.attempts,
    sentAt: r.sentAt,
  }))
}

export function defaultDispatchDeps(): DispatchDeps {
  const db = getDb()
  return {
    now: () => new Date(),
    claimDue,
    saveDelivery: async (id, update) => {
      await db.update(notifications).set(update).where(eq(notifications.id, id))
    },
    getSettings: getNotificationSettings,
    emailConfig: emailConfigFromEnv(),
    pushConfig: pushConfigFromEnv(),
    listSubscriptions: async () => db
      .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
      .from(pushSubscriptions),
    deleteSubscription: async (id) => {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id))
    },
    markSubscriptionOk: async (id, at) => {
      await db.update(pushSubscriptions).set({ lastSuccessAt: at }).where(eq(pushSubscriptions.id, id))
    },
    sendEmail: (cfg, email) => sendEmail(cfg, email),
    sendPush,
  }
}

let draining: Promise<DispatchSummary> | null = null
let drainAgain = false

/**
 * Drain the outbox. Calls that arrive while a drain is running join it and
 * make it go round once more, so rows enqueued mid-drain (a trigger that
 * committed after this tick's claim) go out now instead of next minute.
 */
export function drainNotifications(): Promise<DispatchSummary> {
  if (draining) {
    drainAgain = true
    return draining
  }
  draining = (async () => {
    try {
      let summary: DispatchSummary
      do {
        drainAgain = false
        summary = await dispatchNotifications(defaultDispatchDeps())
      } while (drainAgain)
      return summary
    }
    finally {
      draining = null
    }
  })()
  return draining
}

/** Fire-and-forget drain for producers that just enqueued something. */
export function kickNotifications(): void {
  drainNotifications().catch((err: unknown) => {
    console.error('[notify] immediate drain failed', err instanceof Error ? err.message : err)
  })
}
