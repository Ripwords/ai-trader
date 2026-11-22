import type { FullPortfolio, FullPortfolioAccount } from '../../server/lib/holdings'
import type { PortfolioPerformance } from '../../server/lib/portfolio-history'
import { normalizeAssetClass, type PlanningSummary } from '../../server/lib/planning'

export const PORTFOLIO_TABS = [
  { value: 'overview', label: 'overview' },
  { value: 'holdings', label: 'holdings' },
  { value: 'plan', label: 'plan' },
  { value: 'risk', label: 'risk' },
] as const

export type PortfolioTab = typeof PORTFOLIO_TABS[number]['value']

export function parseTab(q: unknown): PortfolioTab {
  return PORTFOLIO_TABS.find(t => t.value === q)?.value ?? 'overview'
}

export type Tone = 'up' | 'down' | 'accent' | 'neutral'

export function pnlTone(n: number | null | undefined): Tone {
  if (n == null || !Number.isFinite(n) || n === 0) return 'neutral'
  return n > 0 ? 'up' : 'down'
}

export function fmtCurrency(n: number | null | undefined, ccy: string): string {
  if (n == null || !Number.isFinite(n)) return '—'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: ccy || 'USD',
      currencyDisplay: 'code',
      maximumFractionDigits: 2,
    }).format(n).replace(/ /g, ' ')
  } catch {
    return `${ccy} ${n.toFixed(2)}`
  }
}

export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export function fmtQty(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

/** Where a holdings row comes from: the Ghostfolio aggregate across every
 *  account, or one moomoo account on its own. */
export type HoldingSource = 'all' | 'live' | 'paper'

export const SOURCE_LABEL: Record<HoldingSource, string> = {
  all: 'all accounts',
  live: 'moomoo live',
  paper: 'moomoo paper',
}

export interface HoldingRow {
  /** Unique per row: two moomoo accounts can hold the same symbol. */
  key: string
  symbol: string
  name: string | null
  quantity: number
  value: number
  currency: string
  /** Share of net worth; moomoo rows are not part of that denominator. */
  allocationPct: number | null
  pnlPct: number | null
}

export function holdingSources(p: FullPortfolio): HoldingSource[] {
  const out: HoldingSource[] = []
  if (p.positions.length > 0) out.push('all')
  if (p.moomoo_live.length > 0) out.push('live')
  if (p.moomoo_paper.length > 0) out.push('paper')
  return out
}

export function holdingRows(p: FullPortfolio, source: HoldingSource): HoldingRow[] {
  if (source === 'all') {
    return p.positions.map((pos, i) => ({
      key: `${i}:${pos.symbol}`,
      symbol: pos.symbol,
      name: pos.name,
      quantity: pos.quantity,
      value: pos.market_value,
      currency: p.net_worth_currency,
      allocationPct: pos.allocation_pct,
      pnlPct: pos.pnl_pct,
    }))
  }
  const list = source === 'live' ? p.moomoo_live : p.moomoo_paper
  return list.map(pos => ({
    key: `${pos.account_id}:${pos.symbol}`,
    symbol: pos.symbol,
    name: null,
    quantity: pos.quantity,
    value: pos.market_value,
    currency: pos.currency ?? 'USD',
    allocationPct: null,
    pnlPct: pos.pnl_pct,
  }))
}

const isZero = (n: number) => Math.abs(n) < 0.005

export function partitionClosed(rows: HoldingRow[]): { open: HoldingRow[], closed: HoldingRow[] } {
  const open: HoldingRow[] = []
  const closed: HoldingRow[] = []
  for (const row of rows) (isZero(row.quantity) && isZero(row.value) ? closed : open).push(row)
  return { open, closed }
}

export type SortKey = 'symbol' | 'value' | 'allocation' | 'pnl'
export type SortDir = 'asc' | 'desc'

const SORT_FIELD: Record<Exclude<SortKey, 'symbol'>, (r: HoldingRow) => number> = {
  value: r => r.value,
  allocation: r => r.allocationPct ?? 0,
  pnl: r => r.pnlPct ?? 0,
}

export function sortRows(rows: HoldingRow[], key: SortKey, dir: SortDir): HoldingRow[] {
  const sign = dir === 'asc' ? 1 : -1
  if (key === 'symbol') return [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol) * sign)
  const field = SORT_FIELD[key]
  return [...rows].sort((a, b) => (field(a) - field(b)) * sign)
}

export function partitionAccounts(accounts: FullPortfolioAccount[]): { funded: FullPortfolioAccount[], empty: FullPortfolioAccount[] } {
  return {
    funded: accounts.filter(a => !isZero(a.value_in_base)),
    empty: accounts.filter(a => isZero(a.value_in_base)),
  }
}

export interface LockableHolding {
  symbol: string
  name: string
}

/** Holdings the plan editor offers to lock: everything held except cash. */
export function lockableHoldings(p: FullPortfolio): LockableHolding[] {
  return p.positions
    .filter(pos => pos.market_value > 0 && normalizeAssetClass(pos.asset_class) !== 'cash')
    .map(pos => ({ symbol: pos.symbol, name: pos.name || pos.symbol }))
}

export interface KeyFigure {
  label: string
  value: string
  sub: string
  tone: Tone
}

export function keyFigures(p: FullPortfolio, perf: PortfolioPerformance | null): KeyFigure[] {
  const ccy = p.net_worth_currency
  const openCount = partitionClosed(holdingRows(p, 'all')).open.length
  const d1 = perf?.stats.periodReturns.d1 ?? null
  const cashShare = p.cash_total != null && p.net_worth_total ? (p.cash_total / p.net_worth_total) * 100 : null
  return [
    {
      label: 'net worth',
      value: fmtCurrency(p.net_worth_total, ccy),
      sub: `${openCount} open position${openCount === 1 ? '' : 's'}`,
      tone: 'neutral',
    },
    {
      label: '1-day change',
      value: fmtPct(d1),
      sub: d1 == null ? 'needs a snapshot from the last few days' : 'net worth since yesterday, deposits included',
      tone: pnlTone(d1),
    },
    {
      label: 'p&l on cost',
      value: fmtPct(p.total_pnl_pct),
      sub: 'unrealised, against what you paid',
      tone: pnlTone(p.total_pnl_pct),
    },
    {
      label: 'cash',
      value: fmtCurrency(p.cash_total, ccy),
      sub: cashShare == null ? '' : `${cashShare.toFixed(1)}% of net worth`,
      tone: 'neutral',
    },
  ]
}

export interface AttentionItem {
  key: string
  label: string
  detail: string
  tone: Tone
}

/** The plan reports numbers only; how loudly to show them is decided here.
 *  A bucket is off target from 3 points of drift and far off from 10. */
export type DriftLevel = 'on' | 'off' | 'far'

export function driftLevel(driftPct: number): DriftLevel {
  const abs = Math.abs(driftPct)
  return abs >= 10 ? 'far' : abs >= 3 ? 'off' : 'on'
}

/** A single position is worth a look from 5% of investable assets and is
 *  flagged from 20%. */
export function concentrationTone(allocationPct: number): Tone {
  return allocationPct >= 20 ? 'down' : allocationPct >= 5 ? 'accent' : 'neutral'
}

/** What the plan says needs doing: buckets off target with the biggest trade
 *  first, the largest position, then goals not reached. Empty means on track. */
export function attentionItems(plan: PlanningSummary): AttentionItem[] {
  const ccy = plan.base_currency
  const trades = plan.allocation_rows
    .filter(row => row.action !== 'hold' && driftLevel(row.drift_pct) !== 'on')
    .sort((a, b) => Math.abs(b.action_value) - Math.abs(a.action_value))
    .map((row): AttentionItem => ({
      key: `trade-${row.key}`,
      label: row.label,
      detail: `${row.action} ${fmtCurrency(Math.abs(row.action_value), ccy)} · ${row.actual_pct.toFixed(1)}% vs ${row.target_pct.toFixed(1)}% target`,
      tone: 'accent',
    }))
  const top = plan.concentration.top_position
  const concentration: AttentionItem[] = top && concentrationTone(top.allocation_pct) !== 'neutral'
    ? [{
        key: 'concentration',
        label: top.symbol,
        detail: `${top.allocation_pct.toFixed(1)}% of investable assets in one position`,
        tone: concentrationTone(top.allocation_pct),
      }]
    : []
  const goals = plan.goals
    .filter(g => !g.reached)
    .map((g): AttentionItem => ({ key: `goal-${g.key}`, label: g.label, detail: g.note, tone: 'accent' }))
  return [...trades, ...concentration, ...goals]
}
