import type { FullPortfolio, FullPortfolioPosition } from './holdings'

export type PlanningBucketKey =
  | 'cash'
  | 'equity'
  | 'bond'
  | 'crypto'
  | 'real_estate'
  | 'commodity'
  | 'other'

export type PlanningSeverity = 'ok' | 'watch' | 'alert' | 'critical'

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
}

export interface AllocationRow extends PlanningTarget {
  actual_pct: number
  current_value: number
  target_value: number
  drift_pct: number
  action_value: number
  action: 'buy' | 'sell' | 'hold'
  severity: PlanningSeverity
}

export interface PlanningGoal {
  key: string
  label: string
  current_value: number
  target_value: number
  progress_pct: number
  status: 'on_track' | 'behind' | 'complete' | 'not_available'
  note: string
}

export interface ConcentrationSummary {
  top_position: {
    symbol: string
    allocation_pct: number
    severity: PlanningSeverity
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

export interface PlanningSummary {
  base_currency: string
  net_worth_total: number | null
  net_worth_adjusted: number | null
  cash_total: number
  positions_value: number
  data_quality: 'ok' | 'partial'
  assumptions: {
    monthly_expenses: number
    emergency_fund_months: number
    monthly_contribution: number
  }
  target_model: PlanningTarget[]
  allocation_rows: AllocationRow[]
  rebalance_actions: AllocationRow[]
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

export const DEFAULT_PLANNING_SETTINGS: PlanningSettings = {
  target_model: DEFAULT_TARGET_MODEL,
  monthly_expenses: 0,
  emergency_fund_months: 6,
  monthly_contribution: 0,
  liabilities: [],
  cashflow_items: [],
}

const TARGET_KEYS: PlanningBucketKey[] = ['cash', 'equity', 'bond', 'crypto', 'real_estate', 'commodity', 'other']
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
    target_model: DEFAULT_TARGET_MODEL.map(target => byKey.get(target.key)!),
    monthly_expenses: Math.max(0, roundMoney(finiteNumber(rec.monthly_expenses, DEFAULT_PLANNING_SETTINGS.monthly_expenses))),
    emergency_fund_months: clamp(roundPct(finiteNumber(rec.emergency_fund_months, DEFAULT_PLANNING_SETTINGS.emergency_fund_months)), 0, 36),
    monthly_contribution: Math.max(0, roundMoney(finiteNumber(rec.monthly_contribution, DEFAULT_PLANNING_SETTINGS.monthly_contribution))),
    liabilities: normalizeLiabilities(rec.liabilities),
    cashflow_items: normalizeCashflowItems(rec.cashflow_items),
  }
}

function roundPct(value: number): number {
  return Math.round(value * 100) / 100
}

function normalizeAssetClass(value: string | null | undefined): PlanningBucketKey {
  const v = (value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
  if (['CASH', 'MONEY_MARKET'].includes(v)) return 'cash'
  if (['EQUITY', 'STOCK', 'STOCKS', 'ETF', 'ETFS', 'MUTUAL_FUND', 'FUND'].includes(v)) return 'equity'
  if (['BOND', 'BONDS', 'FIXED_INCOME'].includes(v)) return 'bond'
  if (['CRYPTO', 'CRYPTOCURRENCY'].includes(v)) return 'crypto'
  if (['REAL_ESTATE', 'REIT', 'REITS'].includes(v)) return 'real_estate'
  if (['COMMODITY', 'COMMODITIES', 'GOLD', 'SILVER'].includes(v)) return 'commodity'
  return 'other'
}

function driftSeverity(absDriftPct: number): PlanningSeverity {
  if (absDriftPct >= 10) return 'alert'
  if (absDriftPct >= 3) return 'watch'
  return 'ok'
}

function concentrationSeverity(allocationPct: number): PlanningSeverity {
  if (allocationPct >= 20) return 'critical'
  if (allocationPct >= 10) return 'alert'
  if (allocationPct >= 5) return 'watch'
  return 'ok'
}

function currentValuesByBucket(portfolio: FullPortfolio): Record<PlanningBucketKey, number> {
  const values: Record<PlanningBucketKey, number> = {
    cash: Math.max(0, portfolio.cash_total ?? 0),
    equity: 0,
    bond: 0,
    crypto: 0,
    real_estate: 0,
    commodity: 0,
    other: 0,
  }

  for (const p of portfolio.positions) {
    const bucket = normalizeAssetClass(p.asset_class)
    values[bucket] += Math.max(0, p.market_value || 0)
  }

  return values
}

function positionAllocationPct(position: FullPortfolioPosition, netWorth: number): number {
  if (Number.isFinite(position.allocation_pct) && position.allocation_pct > 0) {
    return position.allocation_pct
  }
  if (netWorth <= 0) return 0
  return (position.market_value / netWorth) * 100
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
  const netWorth = portfolio.net_worth_total ?? null
  const baseCurrency = portfolio.net_worth_currency || 'MYR'
  const liabilities = buildLiabilitiesSummary(settings)
  const cashflow = buildCashflowSummary(settings)
  const cashTotal = roundMoney(Math.max(0, portfolio.cash_total ?? 0))
  const positionsValue = roundMoney(Math.max(0, portfolio.positions_value ?? 0))
  const netWorthAdjusted = netWorth == null ? null : roundMoney(netWorth - liabilities.total_balance)

  if (netWorth == null || netWorth <= 0) {
    return {
      base_currency: baseCurrency,
      net_worth_total: netWorth,
      net_worth_adjusted: netWorthAdjusted,
      cash_total: cashTotal,
      positions_value: positionsValue,
      data_quality: 'partial',
      assumptions: {
        monthly_expenses: settings.monthly_expenses,
        emergency_fund_months: settings.emergency_fund_months,
        monthly_contribution: settings.monthly_contribution,
      },
      target_model: settings.target_model,
      allocation_rows: [],
      rebalance_actions: [],
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

  const currentValues = currentValuesByBucket(portfolio)
  const allocationRows = settings.target_model.map((target): AllocationRow => {
    const currentValue = roundMoney(currentValues[target.key] ?? 0)
    const targetValue = roundMoney(netWorth * target.target_pct / 100)
    const actualPct = roundPct(currentValue / netWorth * 100)
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
      severity: driftSeverity(Math.abs(driftPct)),
    }
  })

  const rebalanceActions = allocationRows
    .filter(row => row.action !== 'hold' && row.severity !== 'ok')
    .sort((a, b) => Math.abs(b.action_value) - Math.abs(a.action_value))

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
  const contributionProgressPct = cashReserveTargetValue > 0
    ? Math.min(100, roundPct(settings.monthly_contribution / cashReserveTargetValue * 100))
    : 0

  const sortedPositions = [...portfolio.positions]
    .map(p => ({ symbol: p.symbol, allocation_pct: roundPct(positionAllocationPct(p, netWorth)) }))
    .sort((a, b) => b.allocation_pct - a.allocation_pct)
  const top = sortedPositions[0] ?? null
  const positionsOver10 = sortedPositions.filter(p => p.allocation_pct >= 10).length
  const positionsOver20 = sortedPositions.filter(p => p.allocation_pct >= 20).length
  const concentrationOk = positionsOver20 === 0
  const debtLoadGoal: PlanningGoal | null = liabilities.total_balance > 0
    ? {
        key: 'debt_load',
        label: 'Debt Load',
        current_value: liabilities.total_balance,
        target_value: 0,
        progress_pct: 0,
        status: 'behind',
        note: liabilities.weighted_interest_rate_pct == null
          ? 'Track liabilities to see debt-adjusted net worth.'
          : `Debt balance is weighted at ${liabilities.weighted_interest_rate_pct.toFixed(2)}% interest.`,
      }
    : null

  return {
    base_currency: baseCurrency,
    net_worth_total: netWorth,
    net_worth_adjusted: netWorthAdjusted,
    cash_total: cashTotal,
    positions_value: positionsValue,
    data_quality: portfolio.ghostfolio_status === 'ok' ? 'ok' : 'partial',
    assumptions: {
      monthly_expenses: settings.monthly_expenses,
      emergency_fund_months: settings.emergency_fund_months,
      monthly_contribution: settings.monthly_contribution,
    },
    target_model: settings.target_model,
    allocation_rows: allocationRows,
    rebalance_actions: rebalanceActions,
    goals: [
      {
        key: 'cash_reserve',
        label: 'Cash Reserve',
        current_value: cashTarget?.current_value ?? 0,
        target_value: cashReserveTargetValue,
        progress_pct: cashProgressPct,
        status: cashProgressPct >= 100 ? 'complete' : 'behind',
        note: cashProgressPct >= 100
          ? `Cash meets the ${cashReserveLabel} reserve target.`
          : `Cash is below the ${cashReserveLabel} reserve target.`,
      },
      {
        key: 'monthly_contribution',
        label: 'Monthly Contribution',
        current_value: settings.monthly_contribution,
        target_value: cashReserveTargetValue,
        progress_pct: contributionProgressPct,
        status: settings.monthly_contribution > 0 ? 'on_track' : 'behind',
        note: settings.monthly_contribution > 0
          ? 'Monthly contribution assumption is set for planning projections.'
          : 'Set a monthly contribution to project progress against goals.',
      },
      {
        key: 'concentration',
        label: 'Concentration Control',
        current_value: positionsOver20,
        target_value: 0,
        progress_pct: concentrationOk ? 100 : 0,
        status: concentrationOk ? 'complete' : 'behind',
        note: concentrationOk
          ? 'No single position is above the 20% critical threshold.'
          : `${positionsOver20} position${positionsOver20 === 1 ? '' : 's'} above the 20% critical threshold.`,
      },
      ...(debtLoadGoal ? [debtLoadGoal] : []),
    ],
    concentration: {
      top_position: top
        ? {
            symbol: top.symbol,
            allocation_pct: top.allocation_pct,
            severity: concentrationSeverity(top.allocation_pct),
          }
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
