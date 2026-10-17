import { z } from 'zod'

export const notificationSettingsSchema = z.object({
  /** Recipient for reminder emails. Null: nothing is emailed. */
  email: z.string().email().nullable(),
  /** IANA zone used to read and show reminder times. */
  timezone: z.string().min(1).refine(isValidTimeZone, 'unknown time zone'),
  priceAlerts: z.boolean(),
  reminders: z.boolean(),
  researchRuns: z.boolean(),
})

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  email: null,
  timezone: 'Asia/Kuala_Lumpur',
  priceAlerts: true,
  reminders: true,
  researchRuns: true,
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
