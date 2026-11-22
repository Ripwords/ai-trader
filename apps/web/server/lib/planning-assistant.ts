import { randomUUID } from 'node:crypto'
import type { MoomooStatus } from './holdings'
import {
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

type NotSet = 'not set'
const orNotSet = (v: number): number | NotSet => (v > 0 ? v : 'not set')

/**
 * The plan as the chat reads it. Each fact appears once: the target sits on
 * its allocation row, liabilities carry their own ids, and cash is the cash
 * row. Only the inputs the summary does not already show are listed.
 */
export interface PlanForChat extends Omit<PlanningSummary, 'cash_total' | 'positions_value'> {
  inputs: {
    monthly_expenses: number | NotSet
    emergency_fund_months: number
    monthly_contribution: number | NotSet
    cashflow_items: PlanningCashflowItem[]
    locked_symbols: string[]
  }
}

export function planForChat(summary: PlanningSummary, settings: PlanningSettings): PlanForChat {
  const { cash_total: _cash, positions_value: _positions, ...plan } = summary
  return {
    ...plan,
    inputs: {
      monthly_expenses: orNotSet(settings.monthly_expenses),
      emergency_fund_months: settings.emergency_fund_months,
      monthly_contribution: orNotSet(settings.monthly_contribution),
      cashflow_items: settings.cashflow_items,
      locked_symbols: settings.locked_symbols,
    },
  }
}

/** Something the broker can trade, with what one share costs. */
export interface Instrument {
  symbol: string
  name: string
  bucket: PlanningBucketKey
  /** One share, in `currency`. */
  price: number
  currency: string
  /** Base currency per one unit of `currency`. */
  fx_rate: number
  /** At the broker; 0 for a candidate not held there. */
  held_shares: number
  /** In the base currency. */
  held_value: number
  /** Named by the caller, not picked from the holdings. */
  candidate: boolean
}

export type SkippedSymbol =
  /** one_share is in the base currency. */
  | { symbol: string, reason: 'below_one_share', one_share: number }
  | { symbol: string, reason: 'locked' | 'bucket_required' | 'not_found' | 'not_tradable' | 'no_price' | 'no_fx_rate' | 'no_amount_for_bucket' }

/** What server/lib/rebalance-inputs.ts reads for a plan: every instrument is priced and has its rate. */
export interface RebalanceInputs {
  instruments: Instrument[]
  skipped: SkippedSymbol[]
  /** Live broker cash in each currency it is held in. */
  broker_cash: Record<string, number>
  broker_status: MoomooStatus
  fetched_at: string
}

export interface RebalanceTrade {
  bucket: PlanningBucketKey
  symbol: string
  name: string
  side: 'buy' | 'sell'
  shares: number
  price: number
  currency: string
  fx_rate: number
  /** shares x price, in `currency`. */
  value_native: number
  /** In the base currency. */
  value: number
}

export interface RebalanceBucket {
  key: PlanningBucketKey
  actual_pct: number
  target_pct: number
  /** Base currency the bucket should move by; negative for a sale. */
  planned: number
  /** What the whole-share trades come to. */
  traded: number
  /** How many instruments the bucket could trade. */
  instruments: number
}

export type RebalancePlan = Pick<RebalanceInputs, 'skipped' | 'broker_cash' | 'broker_status' | 'fetched_at'> & {
  base_currency: string
  buckets: RebalanceBucket[]
  trades: RebalanceTrade[]
  /** Per currency traded, in that currency: set `buy` against broker_cash to see what must be converted. */
  currencies: { currency: string, fx_rate: number, buy: number, sell: number }[]
} & (
  /** cash_change: sales less buys, in the base currency. */
  | { mode: 'full', cash_change: number }
  /** unallocated: the part of the contribution no trade spends. */
  | { mode: 'contribute_only', contribution: number, unallocated: number }
)

const sum = (values: number[]) => values.reduce((total, v) => total + v, 0)
const shareCost = (i: Instrument) => i.price * i.fx_rate

/**
 * Whole shares of `ranked` that come to at most `budget`. The first `count`
 * take part, by `weight`. One that cannot trade a single share is dropped,
 * dearest first, and the next in rank takes its place.
 */
function wholeShares(
  budget: number,
  ranked: Instrument[],
  count: number,
  side: 'buy' | 'sell',
): { shares: Map<Instrument, number>, dropped: Instrument[] } {
  const cap = (i: Instrument) => (side === 'sell' ? Math.floor(i.held_shares) : Infinity)
  const weight = (i: Instrument) => (i.candidate ? 1 : i.held_value)
  const pool = ranked.filter(i => cap(i) >= 1)
  let chosen = pool.splice(0, count)
  const dropped: Instrument[] = []
  let target = new Map<Instrument, number>()
  for (;;) {
    const total = sum(chosen.map(weight))
    target = new Map(chosen.map(i => [i, budget * weight(i) / total]))
    const short = chosen.filter(i => target.get(i)! < shareCost(i))
    if (!short.length) break
    const out = short.reduce((a, b) => (shareCost(b) > shareCost(a) ? b : a))
    dropped.push(out)
    chosen = chosen.filter(i => i !== out)
    const next = pool.shift()
    if (next) chosen.push(next)
  }

  const shares = new Map(chosen.map(i => [i, Math.min(cap(i), Math.floor(target.get(i)! / shareCost(i)))]))
  const gap = (i: Instrument) => target.get(i)! - shares.get(i)! * shareCost(i)
  let left = budget - sum(chosen.map(i => shares.get(i)! * shareCost(i)))
  for (const i of [...chosen].sort((a, b) => gap(b) - gap(a))) {
    if (shareCost(i) > left + 1e-9 || shares.get(i)! >= cap(i)) continue
    shares.set(i, shares.get(i)! + 1)
    left -= shareCost(i)
  }
  return { shares, dropped }
}

/** How many of the largest holdings a sale of `sell` needs, and at least `count`. */
function countCovering(ranked: Instrument[], count: number, sell: number): number {
  let n = Math.min(count, ranked.length)
  let covered = sum(ranked.slice(0, n).map(i => i.held_value))
  while (n < ranked.length && covered < sell) covered += ranked[n++]!.held_value
  return n
}

/**
 * Whole-share trades that move the portfolio toward the target model. Full
 * mode buys and sells each bucket to its target. Contribute-only mode spends
 * new money on the underweight buckets in proportion to their shortfall and
 * never sells. A bucket trades the candidates given for it in equal parts,
 * or else its largest maxPerBucket holdings by size (more when a sale needs
 * them). Money that buys no whole share stays unallocated.
 */
export function buildRebalancePlan(
  summary: PlanningSummary,
  inputs: RebalanceInputs,
  opts: { mode: 'full', maxPerBucket?: number } | { mode: 'contribute_only', contribution: number, maxPerBucket?: number },
): RebalancePlan {
  const rows = summary.allocation_rows.filter(r => r.key !== 'cash')
  const amounts = new Map<PlanningBucketKey, number>()
  if (opts.mode === 'full') {
    for (const r of rows) if (Math.abs(r.action_value) >= 1) amounts.set(r.key, r.action_value)
  } else {
    const short = rows.filter(r => r.action_value >= 1)
    const totalShort = sum(short.map(r => r.action_value))
    const spend = Math.min(Math.max(0, opts.contribution), totalShort)
    for (const r of short) amounts.set(r.key, spend * r.action_value / totalShort)
  }

  const skipped = [...inputs.skipped]
  for (const i of inputs.instruments) {
    if (i.candidate && !amounts.has(i.bucket)) skipped.push({ symbol: i.symbol, reason: 'no_amount_for_bucket' })
  }

  const trades: RebalanceTrade[] = []
  const buckets: RebalanceBucket[] = []
  for (const [key, amount] of amounts) {
    const side = amount > 0 ? 'buy' : 'sell'
    const inBucket = inputs.instruments.filter(i => i.bucket === key)
    const named = inBucket.filter(i => i.candidate)
    const ranked = named.length ? named : [...inBucket].sort((a, b) => b.held_value - a.held_value)
    const max = Math.max(1, opts.maxPerBucket ?? 3)
    const count = named.length || (side === 'sell' ? countCovering(ranked, max, -amount) : max)
    const { shares, dropped } = wholeShares(Math.abs(amount), ranked, count, side)
    for (const i of dropped) skipped.push({ symbol: i.symbol, reason: 'below_one_share', one_share: round(shareCost(i)) })

    const made: RebalanceTrade[] = [...shares].filter(([, n]) => n > 0).map(([i, n]) => ({
      bucket: key, symbol: i.symbol, name: i.name, side, shares: n, price: i.price, currency: i.currency, fx_rate: i.fx_rate,
      value_native: round(n * i.price),
      value: round(n * shareCost(i)),
    }))
    trades.push(...made)
    const row = rows.find(r => r.key === key)!
    buckets.push({
      key, actual_pct: row.actual_pct, target_pct: row.target_pct,
      planned: round(amount),
      traded: round(Math.sign(amount) * sum(made.map(t => t.value))),
      instruments: ranked.length,
    })
  }
  trades.sort((a, b) => (a.side === b.side ? b.value - a.value : a.side === 'sell' ? -1 : 1))

  const total = (side: RebalanceTrade['side'], of: (t: RebalanceTrade) => number, currency?: string) =>
    round(sum(trades.filter(t => t.side === side && (!currency || t.currency === currency)).map(of)))
  const common = {
    base_currency: summary.base_currency,
    buckets,
    trades,
    skipped,
    currencies: [...new Map(trades.map(t => [t.currency, t.fx_rate]))].map(([currency, fx_rate]) => ({
      currency, fx_rate, buy: total('buy', t => t.value_native, currency), sell: total('sell', t => t.value_native, currency),
    })),
    broker_cash: inputs.broker_cash,
    broker_status: inputs.broker_status,
    fetched_at: inputs.fetched_at,
  }
  const bought = total('buy', t => t.value)
  if (opts.mode === 'full') return { mode: 'full', ...common, cash_change: round(total('sell', t => t.value) - bought) }
  const contribution = Math.max(0, opts.contribution)
  return { mode: 'contribute_only', ...common, contribution, unallocated: round(contribution - bought) }
}
