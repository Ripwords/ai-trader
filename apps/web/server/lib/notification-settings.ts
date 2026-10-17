import { eq } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { appSettings } from '../../db/schema'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  notificationSettingsSchema,
  type NotificationSettings,
} from '../../types/notifications'

export const NOTIFICATION_SETTINGS_KEY = 'notifications'

/** Stored settings merged over the defaults; a corrupt row reads as defaults. */
export async function getNotificationSettings(): Promise<NotificationSettings> {
  const rows = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, NOTIFICATION_SETTINGS_KEY))
    .limit(1)
  const stored = rows[0]?.value
  const merged = { ...DEFAULT_NOTIFICATION_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) }
  const parsed = notificationSettingsSchema.safeParse(merged)
  return parsed.success ? parsed.data : DEFAULT_NOTIFICATION_SETTINGS
}

export async function saveNotificationSettings(settings: NotificationSettings): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ key: NOTIFICATION_SETTINGS_KEY, value: settings })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: settings, updatedAt: new Date() } })
}
