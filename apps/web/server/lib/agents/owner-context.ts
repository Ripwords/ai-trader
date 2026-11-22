import { listMemories } from '../chat-memory'
import { getHoldingForSymbol, type HoldingPosition, type HoldingSummary } from '../holdings'
import { getPlanningSettings } from '../planning-settings'

/**
 * `unknown` means the accounts could not be read, which is not the same as
 * holding nothing. Only a held position has a size.
 */
export type OwnerPosition =
  | { status: 'not_held' | 'unknown' }
  | {
    status: 'held'
    quantity: number
    market_value: number
    /** Currency of market_value; null when the accounts disagree or did not say. */
    currency: string | null
    weight_pct: number | null
    unrealized_pnl_pct: number | null
  }

/**
 * Who an agents run decides for. Mirrors `OwnerContext` in the api's
 * `schemas/agents.py`, which validates it. Facts only: how the debate must
 * rule for the owner is the `agents.owner_mandate` prompt in Settings.
 */
export interface OwnerContext {
  base_currency: string | null
  position: OwnerPosition
  /** In base_currency. */
  investable_total: number | null
  monthly_contribution: number | null
  /** The owner's saved chat memories, in their words. */
  notes: string[]
}

function ownerPosition(h: HoldingSummary): OwnerPosition {
  if (h.answer_source === 'none') {
    // The tracker aggregates every account, so only it can say "not held".
    return { status: h.ghostfolio_status === 'ok' ? 'not_held' : 'unknown' }
  }
  // The api rejects a negative size, and a short is not something to add to.
  if (!(h.owned_quantity >= 0) || !(h.owned_market_value >= 0)) return { status: 'unknown' }
  const source: HoldingPosition['source'] = h.answer_source === 'moomoo_live' ? 'moomoo_live' : 'ghostfolio'
  const rows = h.positions.filter(p => p.source === source)
  const currencies = new Set(rows.map(p => p.currency))
  const [currency] = currencies.size === 1 ? [...currencies] : [null]
  return {
    status: 'held',
    quantity: h.owned_quantity,
    market_value: h.owned_market_value,
    currency: currency ?? null,
    weight_pct: h.allocation_pct,
    unrealized_pnl_pct: weightedGainPct(rows),
  }
}

function weightedGainPct(rows: HoldingPosition[]): number | null {
  let value = 0
  let weighted = 0
  for (const p of rows) {
    if (p.unrealized_pnl_pct == null || !p.market_value) return null
    value += p.market_value
    weighted += p.market_value * p.unrealized_pnl_pct
  }
  return value > 0 ? weighted / value : null
}

/**
 * Never throws: a run must start even when the accounts, the planning
 * settings or the memories cannot be read. Each is then left out.
 */
export async function buildOwnerContext(symbol: string, userId: string): Promise<OwnerContext> {
  const [holding, planning, memories] = await Promise.allSettled([
    getHoldingForSymbol(symbol),
    getPlanningSettings(),
    listMemories(userId),
  ])
  const h = holding.status === 'fulfilled' ? holding.value : null
  const monthly = planning.status === 'fulfilled' ? planning.value.monthly_contribution : 0
  return {
    base_currency: h?.net_worth_currency ?? null,
    position: h ? ownerPosition(h) : { status: 'unknown' },
    investable_total: h?.net_worth_currency ? h.net_worth_total : null,
    monthly_contribution: monthly > 0 ? monthly : null,
    notes: memories.status === 'fulfilled' ? memories.value.map(m => m.content) : [],
  }
}
