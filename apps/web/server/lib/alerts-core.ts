/**
 * Price alerts — pure core. No DB, no fetch; unit-testable evaluation and
 * shaping only. The DB-touching half lives in ./alerts.ts and the polling
 * timer in server/plugins/price-alerts.ts.
 */

export type AlertKind = 'price_above' | 'price_below' | 'pct_move_day'
export type AlertStatus = 'active' | 'triggered' | 'cancelled'

export const ALERT_KINDS: readonly AlertKind[] = ['price_above', 'price_below', 'pct_move_day'] as const
export const ALERT_STATUSES: readonly AlertStatus[] = ['active', 'triggered', 'cancelled'] as const

/** Wire/API shape of an alert (numerics parsed, dates ISO strings). */
export interface PriceAlert {
  id: string
  symbol: string
  kind: AlertKind
  threshold: number
  note: string | null
  status: AlertStatus
  createdAt: string
  triggeredAt: string | null
  triggeredPrice: number | null
}

/** What the evaluator needs from an alert row. */
export interface EvaluatableAlert {
  kind: AlertKind
  threshold: number
}

/** What the evaluator needs from a quote snapshot. */
export interface AlertQuote {
  lastPrice: number
  prevClosePrice: number
}

export interface AlertTrigger {
  triggered: true
  /** The price that satisfied the condition — stored as triggered_price. */
  price: number
}

/**
 * Decide whether a single alert fires against a quote. Returns null both when
 * the condition simply hasn't crossed AND when the market data is unusable
 * (missing/zero prices) — we skip rather than false-trigger; the next tick
 * re-evaluates with fresh data.
 *
 * Conditions (inclusive touch):
 * - price_above:  last >= threshold
 * - price_below:  last <= threshold
 * - pct_move_day: abs((last - prevClose) / prevClose * 100) >= threshold
 */
export function evaluateAlert(alert: EvaluatableAlert, quote: AlertQuote): AlertTrigger | null {
  const { threshold, kind } = alert
  const last = quote.lastPrice
  if (!Number.isFinite(threshold)) return null
  if (!Number.isFinite(last) || last <= 0) return null

  if (kind === 'price_above') {
    return last >= threshold ? { triggered: true, price: last } : null
  }
  if (kind === 'price_below') {
    return last <= threshold ? { triggered: true, price: last } : null
  }
  // pct_move_day
  const prev = quote.prevClosePrice
  if (!Number.isFinite(prev) || prev <= 0) return null
  const movePct = Math.abs(((last - prev) / prev) * 100)
  return movePct >= threshold ? { triggered: true, price: last } : null
}

/** DB row (drizzle) → wire shape. Numeric columns arrive as strings. */
export interface PriceAlertDbRow {
  id: string
  symbol: string
  kind: string
  threshold: string
  note: string | null
  status: string
  createdAt: Date
  triggeredAt: Date | null
  triggeredPrice: string | null
}

export function shapeAlertRow(row: PriceAlertDbRow): PriceAlert {
  return {
    id: row.id,
    symbol: row.symbol,
    kind: row.kind as AlertKind,
    threshold: Number(row.threshold),
    note: row.note,
    status: row.status as AlertStatus,
    createdAt: row.createdAt.toISOString(),
    triggeredAt: row.triggeredAt ? row.triggeredAt.toISOString() : null,
    triggeredPrice: row.triggeredPrice != null ? Number(row.triggeredPrice) : null,
  }
}
