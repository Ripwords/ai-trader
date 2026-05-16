import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { appSettings } from '../../db/schema'
import {
  mergePlanningSnapshotHistory,
  normalizePlanningSettings,
  type PlanningSettings,
  type PlanningSnapshot,
} from './planning'

const PLANNING_SETTINGS_KEY = 'planning'
const PLANNING_HISTORY_KEY = 'planning_net_worth_history'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizePlanningHistory(input: unknown): PlanningSnapshot[] {
  const rows = Array.isArray(input) ? input : []
  return rows.flatMap((row): PlanningSnapshot[] => {
    if (!isRecord(row)) return []
    if (typeof row.captured_at !== 'string' || typeof row.date !== 'string' || typeof row.base_currency !== 'string') return []
    const liabilitiesTotal = finiteNumberOrNull(row.liabilities_total)
    const cashTotal = finiteNumberOrNull(row.cash_total)
    const positionsValue = finiteNumberOrNull(row.positions_value)
    const monthlySurplus = finiteNumberOrNull(row.monthly_surplus)
    if (liabilitiesTotal == null || cashTotal == null || positionsValue == null || monthlySurplus == null) return []

    return [{
      captured_at: row.captured_at,
      date: row.date,
      base_currency: row.base_currency,
      net_worth_total: finiteNumberOrNull(row.net_worth_total),
      net_worth_adjusted: finiteNumberOrNull(row.net_worth_adjusted),
      liabilities_total: liabilitiesTotal,
      cash_total: cashTotal,
      positions_value: positionsValue,
      monthly_surplus: monthlySurplus,
      savings_rate_pct: finiteNumberOrNull(row.savings_rate_pct),
    }]
  })
}

export async function getPlanningSettings(): Promise<PlanningSettings> {
  const db = getDb()
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, PLANNING_SETTINGS_KEY))
    .limit(1)

  return normalizePlanningSettings(rows[0]?.value)
}

export async function savePlanningSettings(input: unknown): Promise<PlanningSettings> {
  const settings = normalizePlanningSettings(input)
  const db = getDb()
  await db
    .insert(appSettings)
    .values({
      key: PLANNING_SETTINGS_KEY,
      value: settings,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: settings,
        updatedAt: new Date(),
      },
    })
  return settings
}

export async function getPlanningHistory(): Promise<PlanningSnapshot[]> {
  const db = getDb()
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, PLANNING_HISTORY_KEY))
    .limit(1)

  return normalizePlanningHistory(rows[0]?.value)
}

export async function appendPlanningSnapshot(snapshot: PlanningSnapshot): Promise<PlanningSnapshot[]> {
  const db = getDb()
  const history = mergePlanningSnapshotHistory(await getPlanningHistory(), snapshot)
  await db
    .insert(appSettings)
    .values({
      key: PLANNING_HISTORY_KEY,
      value: history,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: history,
        updatedAt: new Date(),
      },
    })
  return history
}
