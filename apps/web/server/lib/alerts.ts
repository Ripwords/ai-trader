import { and, desc, eq, gte, ne } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { priceAlerts } from '../../db/schema'
import {
  shapeAlertRow,
  type AlertKind,
  type AlertStatus,
  type PriceAlert,
} from './alerts-core'
import { getNotificationSettings } from './notification-settings'
import { appPublicUrl, enqueueNotification } from './notifications'
import { priceAlertMessage, type PriceAlertContext } from './price-alert-message'

export type { AlertKind, AlertStatus, PriceAlert }

const LIST_LIMIT = 100

export interface CreateAlertInput {
  symbol: string
  kind: AlertKind
  threshold: number
  note?: string | null
}

export async function createAlert(input: CreateAlertInput): Promise<PriceAlert> {
  const db = getDb()
  const inserted = await db
    .insert(priceAlerts)
    .values({
      symbol: input.symbol,
      kind: input.kind,
      threshold: String(input.threshold),
      note: input.note ?? null,
    })
    .returning()
  if (!inserted[0]) throw new Error('failed to create alert')
  return shapeAlertRow(inserted[0])
}

/**
 * Without a status: every armed alert plus the newest settled ones. Capping
 * the whole list would let a pile of newer fired or cancelled alerts push an
 * old armed one out of view while it can still fire.
 */
export async function listAlerts(opts: { status?: AlertStatus } = {}): Promise<PriceAlert[]> {
  const db = getDb()
  const newest = (status: AlertStatus | undefined, settled = false) => db
    .select()
    .from(priceAlerts)
    .where(settled ? ne(priceAlerts.status, 'active') : status ? eq(priceAlerts.status, status) : undefined)
    .orderBy(desc(priceAlerts.createdAt))
  if (opts.status) return (await newest(opts.status).limit(LIST_LIMIT)).map(shapeAlertRow)
  const [active, settled] = await Promise.all([newest('active'), newest(undefined, true).limit(LIST_LIMIT)])
  return [...active, ...settled]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(shapeAlertRow)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CancelAlertResult = { alert: PriceAlert } | { error: string }

/** Cancel an active alert, or say why it can't be: unknown id, already fired, already cancelled. */
export async function cancelAlert(id: string): Promise<CancelAlertResult> {
  if (!UUID.test(id)) return { error: 'alert not found' }
  const db = getDb()
  const updated = await db
    .update(priceAlerts)
    .set({ status: 'cancelled' })
    .where(and(eq(priceAlerts.id, id), eq(priceAlerts.status, 'active')))
    .returning()
  if (updated[0]) return { alert: shapeAlertRow(updated[0]) }
  const [row] = await db.select().from(priceAlerts).where(eq(priceAlerts.id, id)).limit(1)
  if (!row) return { error: 'alert not found' }
  const alert = shapeAlertRow(row)
  return alert.status === 'triggered'
    ? { error: `alert already triggered at ${alert.triggeredPrice} on ${alert.triggeredAt}, nothing to cancel` }
    : { error: `alert already ${alert.status}` }
}

/** Alerts the evaluation loop needs to look at. */
export async function loadActiveAlerts(): Promise<PriceAlert[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(priceAlerts)
    .where(eq(priceAlerts.status, 'active'))
  return rows.map(shapeAlertRow)
}

/**
 * Flip an active alert to triggered and enqueue its notification in one
 * transaction, so an alert never ends up triggered with nobody told.
 * Guarded on status='active': a cancel racing the evaluation wins, the alert
 * never re-fires, and the call returns null with nothing enqueued.
 * `context` only enriches the email; without it the message is the basic one.
 */
export async function triggerAlert(id: string, price: number, context?: PriceAlertContext, at = new Date()): Promise<PriceAlert | null> {
  const appUrl = appPublicUrl()
  const timeZone = await getNotificationSettings().then(s => s.timezone, () => 'UTC')
  return getDb().transaction(async (tx) => {
    const updated = await tx
      .update(priceAlerts)
      .set({ status: 'triggered', triggeredAt: at, triggeredPrice: String(price) })
      .where(and(eq(priceAlerts.id, id), eq(priceAlerts.status, 'active')))
      .returning()
    if (!updated[0]) return null
    const alert = shapeAlertRow(updated[0])
    await enqueueNotification(priceAlertMessage(alert, appUrl, context, timeZone), tx)
    return alert
  })
}

export interface TriggeredAlertsResponse {
  triggered: PriceAlert[]
  /** How many alerts are still armed — the watcher uses this to decide when to ask for Notification permission. */
  activeCount: number
}

export async function getTriggeredAlerts(since: Date): Promise<TriggeredAlertsResponse> {
  const db = getDb()
  const rows = await db
    .select()
    .from(priceAlerts)
    .where(and(eq(priceAlerts.status, 'triggered'), gte(priceAlerts.triggeredAt, since)))
    .orderBy(desc(priceAlerts.triggeredAt))
    .limit(LIST_LIMIT)
  const active = await db
    .select({ id: priceAlerts.id })
    .from(priceAlerts)
    .where(eq(priceAlerts.status, 'active'))
  return { triggered: rows.map(shapeAlertRow), activeCount: active.length }
}
