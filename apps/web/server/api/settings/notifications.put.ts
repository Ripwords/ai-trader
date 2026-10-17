import { notificationSettingsSchema } from '../../../types/notifications'
import { saveNotificationSettings } from '../../lib/notification-settings'

export default defineEventHandler(async (event) => {
  const settings = await readValidatedBody(event, notificationSettingsSchema.parse)
  await saveNotificationSettings(settings)
  return { settings }
})
