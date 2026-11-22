import { randomUUID } from 'node:crypto'
import type { FullPortfolio } from './holdings'
import {
  normalizeAssetClass,
  normalizePlanningSettings,
  type PlanningBucketKey,
  type PlanningCashflowItem,
  type PlanningLiability,
  type PlanningSettings,
  type PlanningSummary,
} from './planning'

/**
 * The chat's edits to the planning settings and its rebalance plan. Both are
 * pure so the tools in server/llm/tools.ts only load, call and save.
 */

const round = (v: number) => Math.round(v * 100) / 100

export interface PlanningPatch {
  /** Buckets to set; buckets left out keep their current target. */
  target_model?: { key: PlanningBucketKey, target_pct: number }[]
  monthly_expenses?: number
  emergency_fund_months?: number
  monthly_contribution?: number
  /** With an id: replaces that liability. Without: adds one. */
  upsert_liabilities?: (Omit<PlanningLiability, 'id'> & { id?: string })[]
  remove_liability_ids?: string[]
  upsert_cashflow_items?: (Omit<PlanningCashflowItem, 'id'> & { id?: string })[]
  remove_cashflow_ids?: string[]
  /** Replaces the whole list of locked holdings. */
  locked_symbols?: string[]
}

export interface PlanningChange {
  field: string
  before: unknown
  after: unknown
}

export function applyPlanningPatch(
  current: PlanningSettings,
  patch: PlanningPatch,
): { next: PlanningSettings, changes: PlanningChange[] } | { error: string } {
  const targets = new Map(current.target_model.map(t => [t.key, t]))
  for (const t of patch.target_model ?? []) {
    // Rounded as normalizePlanningSettings will store it, so the total
    // checked below is the total saved.
    targets.set(t.key, { key: t.key, label: targets.get(t.key)?.label ?? t.key, target_pct: round(t.target_pct) })
  }
  const total = Math.round([...targets.values()].reduce((sum, t) => sum + t.target_pct, 0) * 100) / 100
  if (Math.abs(total - 100) > 0.001) {
    return { error: `the target model would total ${total}%, not 100%. Give every bucket's target so they add up to 100.` }
  }

  const removed = (rows: { id: string }[], ids: string[] | undefined, what: string): string | null => {
    const missing = (ids ?? []).filter(id => !rows.some(r => r.id === id))
    return missing.length ? `no ${what} with id ${missing.join(', ')}; call planning_get for the ids` : null
  }
  const problem = removed(current.liabilities, patch.remove_liability_ids, 'liability')
    ?? removed(current.cashflow_items, patch.remove_cashflow_ids, 'cashflow item')
  if (problem) return { error: problem }

  const next = normalizePlanningSettings({
    target_model: [...targets.values()],
    monthly_expenses: patch.monthly_expenses ?? current.monthly_expenses,
    emergency_fund_months: patch.emergency_fund_months ?? current.emergency_fund_months,
    monthly_contribution: patch.monthly_contribution ?? current.monthly_contribution,
    liabilities: upsert(current.liabilities, patch.remove_liability_ids, patch.upsert_liabilities, 'liability'),
    cashflow_items: upsert(current.cashflow_items, patch.remove_cashflow_ids, patch.upsert_cashflow_items, 'cashflow'),
    locked_symbols: patch.locked_symbols ?? current.locked_symbols,
  })
  return { next, changes: diffSettings(current, next) }
}

function upsert<T extends { id: string }>(
  rows: T[],
  removeIds: string[] | undefined,
  upserts: (Omit<T, 'id'> & { id?: string })[] | undefined,
  prefix: string,
): T[] {
  const out = rows.filter(r => !removeIds?.includes(r.id))
  for (const u of upserts ?? []) {
    const id = u.id?.trim()
    const at = id ? out.findIndex(r => r.id === id) : -1
    const row = { ...u, id: id || `${prefix}-${randomUUID().slice(0, 8)}` } as T
    if (at >= 0) out[at] = row
    else out.push(row)
  }
  return out
}

function diffSettings(before: PlanningSettings, after: PlanningSettings): PlanningChange[] {
  const changes: PlanningChange[] = []
  const pct = (s: PlanningSettings) => new Map(s.target_model.map(t => [t.key, t.target_pct]))
  const b = pct(before)
  const a = pct(after)
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    if ((b.get(key) ?? 0) !== (a.get(key) ?? 0)) changes.push({ field: `target_model.${key}`, before: b.get(key) ?? 0, after: a.get(key) ?? 0 })
  }
  for (const field of ['monthly_expenses', 'emergency_fund_months', 'monthly_contribution'] as const) {
    if (before[field] !== after[field]) changes.push({ field, before: before[field], after: after[field] })
  }
  for (const field of ['liabilities', 'cashflow_items', 'locked_symbols'] as const) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) changes.push({ field, before: before[field], after: after[field] })
  }
  return changes
}

/**
 * The largest `count` holdings, plus as many more as a sale of `sell` needs:
 * each holding's share of the sale is then at most what it is worth.
 */
function largestCovering<T extends { market_value: number }>(held: T[], count: number, sell: number): T[] {
  const sorted = [...held].sort((a, b) => b.market_value - a.market_value)
  let n = Math.min(count, sorted.length)
  let covered = sorted.slice(0, n).reduce((sum, p) => sum + p.market_value, 0)
  while (n < sorted.length && covered < sell) covered += sorted[n++]!.market_value
  return sorted.slice(0, n)
}

export interface RebalanceTrade {
  bucket: PlanningBucketKey
  /** null when the bucket holds nothing to buy more of: the user picks a fund. */
  symbol: string | null
  name: string | null
  side: 'buy' | 'sell'
  /** In the portfolio's base currency. */
  value: number
  /** Only when the holding is priced in the base currency; else null. */
  approx_quantity: number | null
}

export interface RebalancePlan {
  mode: 'full' | 'contribute_only'
  base_currency: string
  trades: RebalanceTrade[]
  /** Net change to the cash bucket: sales add to it, buys in full mode spend from it. */
  cash_change: number
  /** Contribute-only: money left once every underweight bucket is filled. */
  unallocated_contribution: number
}

/**
 * Trades that move the portfolio to the target model. Full mode buys and
 * sells each bucket to its target, spreading a bucket's amount over its
 * holdings by size. Contribute-only mode spends new money on the underweight
 * buckets in proportion to their shortfall and never sells. Only the largest
 * maxPerBucket holdings of a bucket take part (more when a sale needs them):
 * spread over every holding, a month's contribution came out as slices
 * smaller than one share.
 */
export function buildRebalancePlan(
  summary: PlanningSummary,
  portfolio: FullPortfolio,
  opts: { mode: 'full' | 'contribute_only', contribution?: number, maxPerBucket?: number },
): RebalancePlan {
  const base = summary.base_currency
  const rows = summary.allocation_rows.filter(r => r.key !== 'cash')
  const amounts = new Map<PlanningBucketKey, number>()
  let unallocated = 0

  if (opts.mode === 'full') {
    for (const r of rows) if (Math.abs(r.action_value) >= 1) amounts.set(r.key, r.action_value)
  } else {
    const money = Math.max(0, opts.contribution ?? summary.assumptions.monthly_contribution)
    const short = rows.filter(r => r.action_value >= 1)
    const totalShort = short.reduce((sum, r) => sum + r.action_value, 0)
    const spend = Math.min(money, totalShort)
    for (const r of short) amounts.set(r.key, spend * r.action_value / totalShort)
    unallocated = round(money - spend)
  }

  const locked = new Set(summary.locked.holdings.map(h => h.symbol))
  const trades: RebalanceTrade[] = []
  for (const [bucket, amount] of amounts) {
    const side = amount > 0 ? 'buy' : 'sell'
    const held = largestCovering(
      portfolio.positions.filter(p => normalizeAssetClass(p.asset_class) === bucket && p.market_value > 0 && !locked.has(p.symbol)),
      Math.max(1, opts.maxPerBucket ?? 3),
      side === 'sell' ? -amount : 0,
    )
    if (!held.length) {
      trades.push({ bucket, symbol: null, name: null, side, value: round(Math.abs(amount)), approx_quantity: null })
      continue
    }
    const bucketValue = held.reduce((sum, p) => sum + p.market_value, 0)
    for (const p of held) {
      const value = round(Math.abs(amount) * p.market_value / bucketValue)
      if (value < 1) {
        if (opts.mode === 'contribute_only') unallocated = round(unallocated + value)
        continue
      }
      const priced = p.currency === base && p.market_price > 0
      trades.push({
        bucket, symbol: p.symbol, name: p.name, side, value,
        approx_quantity: priced ? Math.round(value / p.market_price * 1000) / 1000 : null,
      })
    }
  }
  trades.sort((a, b) => (a.side === b.side ? b.value - a.value : a.side === 'sell' ? -1 : 1))

  const sold = trades.filter(t => t.side === 'sell').reduce((sum, t) => sum + t.value, 0)
  const bought = trades.filter(t => t.side === 'buy').reduce((sum, t) => sum + t.value, 0)
  return {
    mode: opts.mode,
    base_currency: base,
    trades,
    cash_change: opts.mode === 'full' ? round(sold - bought) : 0,
    unallocated_contribution: unallocated,
  }
}
