import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { appSettings } from '../../db/schema'
import { DEFAULT_TRADING_SETTINGS, tradingSettingsSchema, type TradingSettings } from '../../types/trading'

export const TRADING_SETTINGS_KEY = 'trading'

/** Stored settings merged over the defaults; a corrupt row reads as defaults (proposals off). */
export async function getTradingSettings(): Promise<TradingSettings> {
  const rows = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, TRADING_SETTINGS_KEY))
    .limit(1)
  const stored = rows[0]?.value
  const merged = { ...DEFAULT_TRADING_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) }
  const parsed = tradingSettingsSchema.safeParse(merged)
  return parsed.success ? parsed.data : DEFAULT_TRADING_SETTINGS
}

export async function saveTradingSettings(settings: TradingSettings): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ key: TRADING_SETTINGS_KEY, value: settings })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: settings, updatedAt: new Date() } })
}
