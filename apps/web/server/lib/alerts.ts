import { and, desc, eq, gte } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { priceAlerts } from '../../db/schema'
import {
  shapeAlertRow,
  type AlertKind,
  type AlertStatus,
  type PriceAlert,
} from './alerts-core'

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

export async function listAlerts(opts: { status?: AlertStatus } = {}): Promise<PriceAlert[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(priceAlerts)
    .where(opts.status ? eq(priceAlerts.status, opts.status) : undefined)
    .orderBy(desc(priceAlerts.createdAt))
    .limit(LIST_LIMIT)
  return rows.map(shapeAlertRow)
}

/** Cancel an active alert. Null when the id doesn't exist or isn't active. */
export async function cancelAlert(id: string): Promise<PriceAlert | null> {
  const db = getDb()
  const updated = await db
    .update(priceAlerts)
    .set({ status: 'cancelled' })
    .where(and(eq(priceAlerts.id, id), eq(priceAlerts.status, 'active')))
    .returning()
  return updated[0] ? shapeAlertRow(updated[0]) : null
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
 * Flip an active alert to triggered. Guarded on status='active' so a
 * cancel racing the evaluation loop wins and the alert never re-fires.
 */
export async function markAlertTriggered(id: string, price: number, at = new Date()): Promise<PriceAlert | null> {
  const db = getDb()
  const updated = await db
    .update(priceAlerts)
    .set({ status: 'triggered', triggeredAt: at, triggeredPrice: String(price) })
    .where(and(eq(priceAlerts.id, id), eq(priceAlerts.status, 'active')))
    .returning()
  return updated[0] ? shapeAlertRow(updated[0]) : null
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
