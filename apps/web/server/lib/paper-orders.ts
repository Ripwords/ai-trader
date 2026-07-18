import { getDb } from '../../db/client'
import { paperOrders } from '../../db/schema'

/**
 * Best-effort writer for the `paper_orders` ledger. Every call site sits on
 * the critical path of a live order placement, so this function NEVER throws
 * — a ledger failure is logged and swallowed, and the order result is
 * returned to the caller untouched. Returns whether the row was written.
 */

export type PaperOrderSource = 'agent_decision' | 'chat' | 'algo'

export interface PaperOrderEntry {
  source: PaperOrderSource
  decisionId?: string | null
  moomooOrderId?: string | null
  accId?: string | null
  symbol: string
  side: 'BUY' | 'SELL'
  qty: number
  price?: number | null
  orderType?: string | null
  trdEnv?: 'SIMULATE' | 'REAL'
  status?: string | null
  raw?: Record<string, unknown> | null
}

export async function recordPaperOrder(entry: PaperOrderEntry): Promise<boolean> {
  try {
    const db = getDb()
    await db.insert(paperOrders).values({
      source: entry.source,
      decisionId: entry.decisionId ?? null,
      moomooOrderId: entry.moomooOrderId ?? null,
      accId: entry.accId ?? null,
      symbol: entry.symbol,
      side: entry.side,
      qty: entry.qty,
      price: entry.price != null ? String(entry.price) : null,
      orderType: entry.orderType ?? null,
      trdEnv: entry.trdEnv ?? 'SIMULATE',
      status: entry.status ?? null,
      raw: entry.raw ?? null,
    })
    return true
  } catch (err) {
    console.warn('[paper-orders] ledger insert failed (order unaffected):', err instanceof Error ? err.message : err)
    return false
  }
}
