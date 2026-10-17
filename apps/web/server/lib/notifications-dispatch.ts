/**
 * One drain of the notifications outbox, with every side effect injected so
 * the delivery rules are testable without a DB or network. The production
 * wiring is `defaultDispatchDeps()` in ./notifications.ts.
 */
import type { NotificationSettings } from '../../types/notifications'
import type { EmailAttachment, EmailConfig, EmailToSend, SendEmailResult } from './email/resend'
import { pushPayload } from './notifications-messages'
import {
  planDelivery,
  settleDelivery,
  type ChannelOutcome,
  type DeliveryStatus,
  type DeliveryUpdate,
  type NotificationKind,
} from './notifications-core'
import type { PushConfig, PushMessage, PushResult, PushTarget } from './push/web-push'

export interface OutboxRow {
  id: string
  kind: NotificationKind
  dedupeKey: string
  subject: string
  bodyText: string
  bodyHtml: string
  url: string | null
  attachments: EmailAttachment[] | null
  emailStatus: DeliveryStatus
  pushStatus: DeliveryStatus
  attempts: number
  sentAt: Date | null
}

export interface StoredSubscription extends PushTarget {
  id: string
}

export interface DispatchDeps {
  now: () => Date
  /** Leases due pending rows until `leaseUntil` so an overlapping drain can't pick them up too. */
  claimDue: (now: Date, leaseUntil: Date, limit: number) => Promise<OutboxRow[]>
  saveDelivery: (id: string, update: DeliveryUpdate) => Promise<void>
  getSettings: () => Promise<NotificationSettings>
  emailConfig: EmailConfig | null
  pushConfig: PushConfig | null
  listSubscriptions: () => Promise<StoredSubscription[]>
  deleteSubscription: (id: string) => Promise<void>
  markSubscriptionOk: (id: string, at: Date) => Promise<void>
  sendEmail: (cfg: EmailConfig, email: EmailToSend) => Promise<SendEmailResult>
  sendPush: (cfg: PushConfig, target: PushTarget, message: PushMessage) => Promise<PushResult>
}

export interface DispatchSummary {
  processed: number
  sent: number
  failed: number
  skipped: number
  pending: number
}

const BATCH = 25
const LEASE_MS = 5 * 60_000

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function deliverEmail(row: OutboxRow, to: string, cfg: EmailConfig, deps: DispatchDeps): Promise<ChannelOutcome> {
  try {
    const res = await deps.sendEmail(cfg, {
      to,
      subject: row.subject,
      html: row.bodyHtml,
      text: row.bodyText,
      // Stable per row: a retry after a crash mid-send gets Resend's replay, not a second email.
      idempotencyKey: `notification:${row.id}`,
      ...(row.attachments?.length ? { attachments: row.attachments } : {}),
    })
    if (res.ok) return { result: 'sent' }
    return res.permanent ? { result: 'failed', error: res.error } : { result: 'retry', error: res.error }
  }
  catch (err) {
    return { result: 'retry', error: `email: ${errText(err)}` }
  }
}

/** Sent when any device took it; gone devices are deleted and dropped from `subs` for later rows. */
async function deliverPush(row: OutboxRow, subs: StoredSubscription[], cfg: PushConfig, deps: DispatchDeps): Promise<ChannelOutcome> {
  const message = pushPayload(row)
  const errors: string[] = []
  let delivered = false
  for (const sub of [...subs]) {
    let res: PushResult
    try {
      res = await deps.sendPush(cfg, sub, message)
    }
    catch (err) {
      res = { result: 'error', error: errText(err) }
    }
    if (res.result === 'sent') {
      delivered = true
      await deps.markSubscriptionOk(sub.id, deps.now()).catch(() => {})
    }
    else if (res.result === 'gone') {
      subs.splice(subs.indexOf(sub), 1)
      await deps.deleteSubscription(sub.id).catch((err: unknown) => {
        console.error('[notify] failed to delete gone push subscription', sub.id, errText(err))
      })
    }
    else {
      errors.push(res.error)
    }
  }
  if (delivered) return { result: 'sent' }
  if (errors.length) return { result: 'retry', error: errors.join(' | ') }
  return { result: 'skipped', reason: 'no device subscribed' }
}

export async function dispatchNotifications(deps: DispatchDeps): Promise<DispatchSummary> {
  const summary: DispatchSummary = { processed: 0, sent: 0, failed: 0, skipped: 0, pending: 0 }
  const now = deps.now()
  const rows = await deps.claimDue(now, new Date(now.getTime() + LEASE_MS), BATCH)
  if (rows.length === 0) return summary

  const settings = await deps.getSettings()
  const subs = deps.pushConfig ? await deps.listSubscriptions() : []

  for (const row of rows) {
    summary.processed++
    try {
      const plan = planDelivery(row, {
        settings,
        emailConfigured: deps.emailConfig !== null,
        pushConfigured: deps.pushConfig !== null,
        subscriptionCount: subs.length,
      })
      const outcomes: { email?: ChannelOutcome; push?: ChannelOutcome } = {}

      if (plan.email.action === 'skip') outcomes.email = { result: 'skipped', reason: plan.email.reason }
      else if (plan.email.action === 'send' && deps.emailConfig && settings.email) {
        outcomes.email = await deliverEmail(row, settings.email, deps.emailConfig, deps)
      }

      if (plan.push.action === 'skip') outcomes.push = { result: 'skipped', reason: plan.push.reason }
      else if (plan.push.action === 'send' && deps.pushConfig) {
        outcomes.push = await deliverPush(row, subs, deps.pushConfig, deps)
      }

      const update = settleDelivery(row, outcomes, deps.now())
      await deps.saveDelivery(row.id, update)
      summary[update.status]++
    }
    catch (err) {
      // The lease expires and the next drain retries this row.
      console.error('[notify] delivery failed for', row.id, errText(err))
    }
  }
  return summary
}
