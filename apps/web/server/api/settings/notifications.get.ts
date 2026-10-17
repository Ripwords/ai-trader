import { getNotificationSettings } from '../../lib/notification-settings'
import { emailConfigFromEnv } from '../../lib/email/resend'
import { pushConfigFromEnv } from '../../lib/push/web-push'

export default defineEventHandler(async () => ({
  settings: await getNotificationSettings(),
  // Whether the server can send at all; the page explains a missing key.
  emailConfigured: emailConfigFromEnv() !== null,
  pushConfigured: pushConfigFromEnv() !== null,
}))
