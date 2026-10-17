/**
 * Notifications outbox — pure core. Decides which channel a row goes out on,
 * how a delivery attempt settles the row, and when to retry. The DB and
 * network half lives in ./notifications.ts and ./notifications-dispatch.ts.
 */
import type { NotificationSettings } from '../../types/notifications'

export const NOTIFICATION_KINDS = ['price_alert', 'reminder', 'research_run', 'test'] as const
export type NotificationKind = typeof NOTIFICATION_KINDS[number]

export const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'skipped'] as const
export type DeliveryStatus = typeof DELIVERY_STATUSES[number]

export type Channel = 'email' | 'push'
export const CHANNELS: readonly Channel[] = ['email', 'push']

/** Total delivery attempts per row before its still-pending channels become failed. */
export const MAX_ATTEMPTS = 5

const BACKOFF_BASE_MS = 60_000
const BACKOFF_CAP_MS = 6 * 60 * 60_000

/** Toggles live in Settings → Notifications; a test notification ignores them. */
export function categoryEnabled(
  settings: Pick<NotificationSettings, 'priceAlerts' | 'reminders' | 'researchRuns'>,
  kind: NotificationKind,
): boolean {
  if (kind === 'price_alert') return settings.priceAlerts
  if (kind === 'reminder') return settings.reminders
  if (kind === 'research_run') return settings.researchRuns
  return true
}

/** Wait before the next try after `attempts` tries: 1, 4, 16, 64 min…, capped at 6 h. */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, attempts)
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 4 ** Math.min(n - 1, 10))
}

/** Row status from its two channel statuses. */
export function rollUpStatus(email: DeliveryStatus, push: DeliveryStatus): DeliveryStatus {
  const all = [email, push]
  if (all.includes('pending')) return 'pending'
  if (all.includes('sent')) return 'sent'
  if (all.includes('failed')) return 'failed'
  return 'skipped'
}

export interface DeliveryContext {
  settings: NotificationSettings
  /** RESEND_API_KEY and RESEND_DOMAIN are set. */
  emailConfigured: boolean
  /** VAPID keys are set. */
  pushConfigured: boolean
  subscriptionCount: number
}

export type ChannelPlan =
  | { action: 'send' }
  | { action: 'skip'; reason: string }
  /** The channel already settled on an earlier attempt. */
  | { action: 'none' }

export function planDelivery(
  row: { kind: NotificationKind; emailStatus: DeliveryStatus; pushStatus: DeliveryStatus },
  ctx: DeliveryContext,
): Record<Channel, ChannelPlan> {
  const enabled = categoryEnabled(ctx.settings, row.kind)
  const plan = (status: DeliveryStatus, blocker: string | null): ChannelPlan => {
    if (status !== 'pending') return { action: 'none' }
    if (!enabled) return { action: 'skip', reason: 'category turned off in Settings' }
    if (blocker) return { action: 'skip', reason: blocker }
    return { action: 'send' }
  }
  return {
    email: plan(
      row.emailStatus,
      !ctx.emailConfigured ? 'RESEND_API_KEY or RESEND_DOMAIN not set'
        : !ctx.settings.email ? 'no recipient set in Settings'
          : null,
    ),
    push: plan(
      row.pushStatus,
      !ctx.pushConfigured ? 'VAPID keys not set'
        : ctx.subscriptionCount === 0 ? 'no device subscribed'
          : null,
    ),
  }
}

export type ChannelOutcome =
  | { result: 'sent' }
  | { result: 'skipped'; reason: string }
  /** Transient: try again after the backoff. */
  | { result: 'retry'; error: string }
  /** Permanent: retrying cannot help (e.g. the provider rejected the request). */
  | { result: 'failed'; error: string }

export interface DeliveryRowState {
  emailStatus: DeliveryStatus
  pushStatus: DeliveryStatus
  attempts: number
  sentAt: Date | null
}

export interface DeliveryUpdate {
  status: DeliveryStatus
  emailStatus: DeliveryStatus
  pushStatus: DeliveryStatus
  attempts: number
  nextAttemptAt: Date
  /** Last error, or why a channel was skipped. */
  lastError: string | null
  sentAt: Date | null
}

/** Fold one attempt's per-channel outcomes into the row. Channels without an outcome keep their status. */
export function settleDelivery(
  row: DeliveryRowState,
  outcomes: Partial<Record<Channel, ChannelOutcome>>,
  now: Date,
): DeliveryUpdate {
  const tried = CHANNELS.some(c => outcomes[c] && outcomes[c]!.result !== 'skipped')
  const attempts = row.attempts + (tried ? 1 : 0)
  const notes: string[] = []

  const next = (channel: Channel, current: DeliveryStatus): DeliveryStatus => {
    const o = outcomes[channel]
    if (!o) return current
    if (o.result === 'sent') return 'sent'
    if (o.result === 'skipped') {
      notes.push(`${channel} skipped: ${o.reason}`)
      return 'skipped'
    }
    notes.push(`${channel}: ${o.error}`)
    if (o.result === 'failed') return 'failed'
    return attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
  }

  const emailStatus = next('email', row.emailStatus)
  const pushStatus = next('push', row.pushStatus)
  const status = rollUpStatus(emailStatus, pushStatus)
  const delivered = CHANNELS.some(c => outcomes[c]?.result === 'sent')
  return {
    status,
    emailStatus,
    pushStatus,
    attempts,
    nextAttemptAt: status === 'pending' ? new Date(now.getTime() + backoffMs(attempts)) : now,
    lastError: notes.length ? notes.join('; ') : null,
    sentAt: row.sentAt ?? (delivered ? now : null),
  }
}
