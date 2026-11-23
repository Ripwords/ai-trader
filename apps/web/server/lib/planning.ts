import type { FullPortfolio } from './holdings'

export type PlanningBucketKey =
  | 'cash'
  | 'equity'
  | 'bond'
  | 'crypto'
  | 'real_estate'
  | 'commodity'
  | 'other'

export interface PlanningTarget {
  key: PlanningBucketKey
  label: string
  target_pct: number
}

export interface PlanningLiability {
  id: string
  name: string
  balance: number
  interest_rate_pct: number
  minimum_payment: number
}

export type PlanningCashflowKind = 'income' | 'expense' | 'saving'

export interface PlanningCashflowItem {
  id: string
  name: string
  kind: PlanningCashflowKind
  amount: number
}

export interface PlanningSettings {
  target_model: PlanningTarget[]
  monthly_expenses: number
  emergency_fund_months: number
  monthly_contribution: number
  liabilities: PlanningLiability[]
  cashflow_items: PlanningCashflowItem[]
  /**
   * Holdings the owner cannot or will not trade, such as a pension. They count
   * toward net worth and are left out of allocation, concentration and
   * rebalancing.
   */
  locked_symbols: string[]
}

export interface AllocationRow extends PlanningTarget {
  actual_pct: number
  current_value: number
  target_value: number
  drift_pct: number
  action_value: number
  action: 'buy' | 'sell' | 'hold'
}

export interface PlanningGoal {
  key: string
  label: string
  current_value: number
  target_value: number
  progress_pct: number
  reached: boolean
  note: string
}

export interface ConcentrationSummary {
  top_position: {
    symbol: string
    allocation_pct: number
  } | null
  positions_over_10_pct: number
  positions_over_20_pct: number
}

export interface LiabilitiesSummary {
  total_balance: number
  monthly_minimum_payment: number
  weighted_interest_rate_pct: number | null
  rows: PlanningLiability[]
}

export interface CashflowSummary {
  monthly_income: number
  monthly_expenses: number
  monthly_savings: number
  monthly_surplus: number
  savings_rate_pct: number | null
}

export interface LockedHolding {
  symbol: string
  name: string
  value: number
}

export interface PlanningSummary {
  base_currency: string
  net_worth_total: number | null
  net_worth_adjusted: number | null
  /**
   * Net worth less the locked holdings. Allocation rows and concentration are
   * percentages of this, not of net worth.
   */
  investable_total: number | null
  locked: { total: number, holdings: LockedHolding[] }
  cash_total: number
  positions_value: number
  data_quality: 'ok' | 'partial'
  allocation_rows: AllocationRow[]
  goals: PlanningGoal[]
  concentration: ConcentrationSummary
  liabilities: LiabilitiesSummary
  cashflow: CashflowSummary
}

export interface PlanningSnapshot {
  captured_at: string
  date: string
  base_currency: string
  net_worth_total: number | null
  net_worth_adjusted: number | null
  liabilities_total: number
  cash_total: number
  positions_value: number
  monthly_surplus: number
  savings_rate_pct: number | null
}

export const DEFAULT_TARGET_MODEL: PlanningTarget[] = [
  { key: 'cash', label: 'Cash', target_pct: 10 },
  { key: 'equity', label: 'Equity', target_pct: 85 },
  { key: 'bond', label: 'Bonds', target_pct: 5 },
]

/** Ghostfolio's manual symbol for the KWSP/EPF pension. */
export const DEFAULT_LOCKED_SYMBOLS = ['GF_KWSP']

export const DEFAULT_PLANNING_SETTINGS: PlanningSettings = {
  target_model: DEFAULT_TARGET_MODEL,
  monthly_expenses: 0,
  emergency_fund_months: 6,
  monthly_contribution: 0,
  liabilities: [],
  cashflow_items: [],
  locked_symbols: DEFAULT_LOCKED_SYMBOLS,
}

const TARGET_KEYS: PlanningBucketKey[] = ['cash', 'equity', 'bond', 'crypto', 'real_estate', 'commodity', 'other']
const BUCKET_LABELS: Record<PlanningBucketKey, string> = {
  cash: 'Cash',
  equity: 'Equity',
  bond: 'Bonds',
  crypto: 'Crypto',
  real_estate: 'Real Estate',
  commodity: 'Commodities',
  other: 'Other',
}
const CASHFLOW_KINDS: PlanningCashflowKind[] = ['income', 'expense', 'saving']

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function isPlanningBucketKey(value: unknown): value is PlanningBucketKey {
  return typeof value === 'string' && TARGET_KEYS.includes(value as PlanningBucketKey)
}

function isPlanningCashflowKind(value: unknown): value is PlanningCashflowKind {
  return typeof value === 'string' && CASHFLOW_KINDS.includes(value as PlanningCashflowKind)
}

function normalizeId(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  return raw || fallback
}

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeLiabilities(input: unknown): PlanningLiability[] {
  const rawRows = Array.isArray(input) ? input : []
  const rows: PlanningLiability[] = []

  rawRows.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const name = normalizeName(raw.name)
    const balance = Math.max(0, roundMoney(finiteNumber(raw.balance, 0)))
    if (!name || balance <= 0) return

    rows.push({
      id: normalizeId(raw.id, `liability-${index + 1}`),
      name,
      balance,
      interest_rate_pct: clamp(roundPct(finiteNumber(raw.interest_rate_pct, 0)), 0, 100),
      minimum_payment: Math.max(0, roundMoney(finiteNumber(raw.minimum_payment, 0))),
    })
  })

  return rows
}

function normalizeCashflowItems(input: unknown): PlanningCashflowItem[] {
  const rawRows = Array.isArray(input) ? input : []
  const rows: PlanningCashflowItem[] = []

  rawRows.forEach((raw, index) => {
    if (!isRecord(raw) || !isPlanningCashflowKind(raw.kind)) return
    const name = normalizeName(raw.name)
    const amount = Math.max(0, roundMoney(finiteNumber(raw.amount, 0)))
    if (!name || amount <= 0) return

    rows.push({
      id: normalizeId(raw.id, `cashflow-${index + 1}`),
      name,
      kind: raw.kind,
      amount,
    })
  })

  return rows
}

/** An explicit empty list means the owner unlocked everything; only a missing key takes the default. */
function normalizeLockedSymbols(input: unknown): string[] {
  if (!Array.isArray(input)) return [...DEFAULT_LOCKED_SYMBOLS]
  return [...new Set(input.filter((v): v is string => typeof v === 'string').map(v => v.trim()).filter(Boolean))]
}

export function normalizePlanningSettings(input: unknown = {}): PlanningSettings {
  const rec = isRecord(input) ? input : {}
  const rawTargets = Array.isArray(rec.target_model) ? rec.target_model : []
  const byKey = new Map<PlanningBucketKey, PlanningTarget>()

  for (const raw of rawTargets) {
    if (!isRecord(raw) || !isPlanningBucketKey(raw.key)) continue
    // Keep an explicitly submitted 0 (user zeroing a bucket). Dropping it
    // here let the default backfill below re-inflate it to its default %,
    // breaking the 100% total and wedging the /portfolio save button.
    // A genuinely missing key is still backfilled from DEFAULT_TARGET_MODEL.
    const targetPct = clamp(roundPct(finiteNumber(raw.target_pct, 0)), 0, 100)
    byKey.set(raw.key, {
      key: raw.key,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : raw.key,
      target_pct: targetPct,
    })
  }

  for (const target of DEFAULT_TARGET_MODEL) {
    if (!byKey.has(target.key)) byKey.set(target.key, target)
  }

  return {
    // Backfill above guarantees every default key is present, so the
    // assertion is safe. Keep 0% buckets in the model (no `> 0` filter): a
    // user-zeroed allocation must round-trip stably and stay editable in the
    // UI instead of being erased and re-inflated to its default on reload.
    // Buckets beyond the defaults (crypto, real estate, ...) that the user
    // submitted are kept after them in the order TARGET_KEYS declares.
    target_model: [
      ...DEFAULT_TARGET_MODEL.map(target => byKey.get(target.key)!),
      ...TARGET_KEYS
        .filter(key => byKey.has(key) && !DEFAULT_TARGET_MODEL.some(t => t.key === key))
        .map(key => byKey.get(key)!),
    ],
    monthly_expenses: Math.max(0, roundMoney(finiteNumber(rec.monthly_expenses, DEFAULT_PLANNING_SETTINGS.monthly_expenses))),
    emergency_fund_months: clamp(roundPct(finiteNumber(rec.emergency_fund_months, DEFAULT_PLANNING_SETTINGS.emergency_fund_months)), 0, 36),
    monthly_contribution: Math.max(0, roundMoney(finiteNumber(rec.monthly_contribution, DEFAULT_PLANNING_SETTINGS.monthly_contribution))),
    liabilities: normalizeLiabilities(rec.liabilities),
    cashflow_items: normalizeCashflowItems(rec.cashflow_items),
    locked_symbols: normalizeLockedSymbols(rec.locked_symbols),
  }
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100
}

export function normalizeAssetClass(value: string | null | undefined): PlanningBucketKey {
  const v = (value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
  if (['CASH', 'LIQUIDITY', 'MONEY_MARKET'].includes(v)) return 'cash'
  if (['EQUITY', 'STOCK', 'STOCKS', 'ETF', 'ETFS', 'MUTUAL_FUND', 'FUND'].includes(v)) return 'equity'
  if (['BOND', 'BONDS', 'FIXED_INCOME'].includes(v)) return 'bond'
  if (['CRYPTO', 'CRYPTOCURRENCY'].includes(v)) return 'crypto'
  if (['REAL_ESTATE', 'REIT', 'REITS'].includes(v)) return 'real_estate'
  if (['COMMODITY', 'COMMODITIES', 'GOLD', 'SILVER'].includes(v)) return 'commodity'
  return 'other'
}

function currentValuesByBucket(portfolio: FullPortfolio, locked: ReadonlySet<string>): Record<PlanningBucketKey, number> {
  // Ghostfolio lists cash as LIQUIDITY holdings, and those holdings already
  // add up to net worth. Adding cash_total on top made the rows sum past
  // 100%, so cash_total is used only when no holding is cash.
  const holdsCash = portfolio.positions.some(p => normalizeAssetClass(p.asset_class) === 'cash')
  const values: Record<PlanningBucketKey, number> = {
    cash: holdsCash ? 0 : Math.max(0, portfolio.cash_total ?? 0),
    equity: 0,
    bond: 0,
    crypto: 0,
    real_estate: 0,
    commodity: 0,
    other: 0,
  }

  for (const p of portfolio.positions) {
    if (locked.has(p.symbol)) continue
    const bucket = normalizeAssetClass(p.asset_class)
    values[bucket] += Math.max(0, p.market_value || 0)
  }

  return values
}

function buildLiabilitiesSummary(settings: PlanningSettings): LiabilitiesSummary {
  const rows = [...settings.liabilities].sort((a, b) => {
    const rateDiff = b.interest_rate_pct - a.interest_rate_pct
    if (rateDiff !== 0) return rateDiff
    return b.balance - a.balance
  })
  const totalBalance = roundMoney(rows.reduce((sum, row) => sum + row.balance, 0))
  const monthlyMinimumPayment = roundMoney(rows.reduce((sum, row) => sum + row.minimum_payment, 0))
  const weightedInterestRatePct = totalBalance > 0
    ? roundPct(rows.reduce((sum, row) => sum + row.balance * row.interest_rate_pct, 0) / totalBalance)
    : null

  return {
    total_balance: totalBalance,
    monthly_minimum_payment: monthlyMinimumPayment,
    weighted_interest_rate_pct: weightedInterestRatePct,
    rows,
  }
}

function buildCashflowSummary(settings: PlanningSettings): CashflowSummary {
  const hasDetailedCashflow = settings.cashflow_items.length > 0
  const monthlyIncome = roundMoney(settings.cashflow_items
    .filter(row => row.kind === 'income')
    .reduce((sum, row) => sum + row.amount, 0))
  const itemExpenses = roundMoney(settings.cashflow_items
    .filter(row => row.kind === 'expense')
    .reduce((sum, row) => sum + row.amount, 0))
  const itemSavings = roundMoney(settings.cashflow_items
    .filter(row => row.kind === 'saving')
    .reduce((sum, row) => sum + row.amount, 0))
  const monthlyExpenses = hasDetailedCashflow ? itemExpenses : settings.monthly_expenses
  const monthlySavings = hasDetailedCashflow ? itemSavings : settings.monthly_contribution
  const monthlySurplus = roundMoney(monthlyIncome - monthlyExpenses - monthlySavings)
  const savingsRatePct = monthlyIncome > 0 ? roundPct(monthlySavings / monthlyIncome * 100) : null

  return {
    monthly_income: monthlyIncome,
    monthly_expenses: monthlyExpenses,
    monthly_savings: monthlySavings,
    monthly_surplus: monthlySurplus,
    savings_rate_pct: savingsRatePct,
  }
}

export function buildPlanningSummary(portfolio: FullPortfolio, inputSettings?: unknown): PlanningSummary {
  const settings = normalizePlanningSettings(inputSettings)
  const netWorth = portfolio.net_worth_total == null ? null : roundMoney(portfolio.net_worth_total)
  const baseCurrency = portfolio.net_worth_currency || 'MYR'
  const liabilities = buildLiabilitiesSummary(settings)
  const cashflow = buildCashflowSummary(settings)
  const cashTotal = roundMoney(Math.max(0, portfolio.cash_total ?? 0))
  const positionsValue = roundMoney(Math.max(0, portfolio.positions_value ?? 0))
  const netWorthAdjusted = netWorth == null ? null : roundMoney(netWorth - liabilities.total_balance)
  const lockedSymbols = new Set(settings.locked_symbols)
  const lockedHoldings = portfolio.positions
    .filter(p => lockedSymbols.has(p.symbol) && p.market_value > 0)
    .map((p): LockedHolding => ({ symbol: p.symbol, name: p.name, value: roundMoney(p.market_value) }))
    .sort((a, b) => b.value - a.value)
  const locked = { total: roundMoney(lockedHoldings.reduce((sum, h) => sum + h.value, 0)), holdings: lockedHoldings }
  const investable = netWorth == null ? null : roundMoney(netWorth - locked.total)

  if (investable == null || investable <= 0) {
    return {
      base_currency: baseCurrency,
      net_worth_total: netWorth,
      net_worth_adjusted: netWorthAdjusted,
      investable_total: investable,
      locked,
      cash_total: cashTotal,
      positions_value: positionsValue,
      data_quality: 'partial',
      allocation_rows: [],
      goals: [],
      concentration: {
        top_position: null,
        positions_over_10_pct: 0,
        positions_over_20_pct: 0,
      },
      liabilities,
      cashflow,
    }
  }

  const currentValues = currentValuesByBucket(portfolio, lockedSymbols)
  // Every bucket the user targets, plus every bucket they actually hold.
  // Investable assets count all seven buckets, so a held bucket with no target row
  // (say crypto at 30%) would otherwise make the rows sum to 70% and tell
  // the user to buy equity into a fully invested portfolio.
  const targeted = new Set(settings.target_model.map(t => t.key))
  const heldUntargeted = TARGET_KEYS
    .filter(key => !targeted.has(key) && (currentValues[key] ?? 0) > 0)
    .map((key): PlanningTarget => ({ key, label: BUCKET_LABELS[key], target_pct: 0 }))
  const allocationRows = [...settings.target_model, ...heldUntargeted].map((target): AllocationRow => {
    const currentValue = roundMoney(currentValues[target.key] ?? 0)
    const targetValue = roundMoney(investable * target.target_pct / 100)
    const actualPct = roundPct(currentValue / investable * 100)
    const driftPct = roundPct(actualPct - target.target_pct)
    const actionValue = roundMoney(targetValue - currentValue)
    const action: AllocationRow['action'] = Math.abs(actionValue) < 1
      ? 'hold'
      : actionValue > 0
        ? 'buy'
        : 'sell'
    return {
      ...target,
      actual_pct: actualPct,
      current_value: currentValue,
      target_value: targetValue,
      drift_pct: driftPct,
      action_value: actionValue,
      action,
    }
  })

  const cashTarget = allocationRows.find(row => row.key === 'cash')
  const emergencyFundTarget = settings.monthly_expenses > 0
    ? roundMoney(settings.monthly_expenses * settings.emergency_fund_months)
    : 0
  const cashReserveLabel = emergencyFundTarget > 0
    ? `${settings.emergency_fund_months}-month`
    : `${cashTarget?.target_pct ?? 0}%`
  const cashReserveTargetValue = Math.max(cashTarget?.target_value ?? 0, emergencyFundTarget)
  const cashProgressPct = cashReserveTargetValue > 0
    ? Math.min(100, roundPct((cashTarget?.current_value ?? 0) / cashReserveTargetValue * 100))
    : 0

  const sortedPositions = portfolio.positions
    .filter(p => normalizeAssetClass(p.asset_class) !== 'cash' && !lockedSymbols.has(p.symbol))
    .map(p => ({ symbol: p.symbol, allocation_pct: roundPct(p.market_value / investable * 100) }))
    .sort((a, b) => b.allocation_pct - a.allocation_pct)
  const top = sortedPositions[0] ?? null
  const positionsOver10 = sortedPositions.filter(p => p.allocation_pct >= 10).length
  const positionsOver20 = sortedPositions.filter(p => p.allocation_pct >= 20).length
  const debtLoadGoal: PlanningGoal | null = liabilities.total_balance > 0
    ? {
        key: 'debt_load',
        label: 'Debt Load',
        current_value: liabilities.total_balance,
        target_value: 0,
        progress_pct: 0,
        reached: false,
        note: liabilities.weighted_interest_rate_pct == null
          ? 'Track liabilities to see debt-adjusted net worth.'
          : `Debt balance is weighted at ${liabilities.weighted_interest_rate_pct.toFixed(2)}% interest.`,
      }
    : null

  return {
    base_currency: baseCurrency,
    net_worth_total: netWorth,
    net_worth_adjusted: netWorthAdjusted,
    investable_total: investable,
    locked,
    cash_total: cashTotal,
    positions_value: positionsValue,
    data_quality: portfolio.ghostfolio_status === 'ok' ? 'ok' : 'partial',
    allocation_rows: allocationRows,
    goals: [
      {
        key: 'cash_reserve',
        label: 'Cash Reserve',
        current_value: cashTarget?.current_value ?? 0,
        target_value: cashReserveTargetValue,
        progress_pct: cashProgressPct,
        reached: cashProgressPct >= 100,
        note: cashProgressPct >= 100
          ? `Cash meets the ${cashReserveLabel} reserve target.`
          : `Cash is below the ${cashReserveLabel} reserve target.`,
      },
      ...(debtLoadGoal ? [debtLoadGoal] : []),
    ],
    concentration: {
      top_position: top
        ? { symbol: top.symbol, allocation_pct: top.allocation_pct }
        : null,
      positions_over_10_pct: positionsOver10,
      positions_over_20_pct: positionsOver20,
    },
    liabilities,
    cashflow,
  }
}

export function buildPlanningSnapshot(summary: PlanningSummary, capturedAt = new Date()): PlanningSnapshot {
  const captured_at = capturedAt.toISOString()
  return {
    captured_at,
    date: captured_at.slice(0, 10),
    base_currency: summary.base_currency,
    net_worth_total: summary.net_worth_total,
    net_worth_adjusted: summary.net_worth_adjusted,
    liabilities_total: summary.liabilities.total_balance,
    cash_total: summary.cash_total,
    positions_value: summary.positions_value,
    monthly_surplus: summary.cashflow.monthly_surplus,
    savings_rate_pct: summary.cashflow.savings_rate_pct,
  }
}

export function mergePlanningSnapshotHistory(
  existing: PlanningSnapshot[],
  snapshot: PlanningSnapshot,
  limit = 365,
): PlanningSnapshot[] {
  const byDate = new Map<string, PlanningSnapshot>()
  for (const row of existing) {
    byDate.set(row.date, row)
  }
  byDate.set(snapshot.date, snapshot)

  return [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(Math.max(0, byDate.size - Math.max(1, limit)))
}
