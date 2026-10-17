import { emailConfigFromEnv, sendEmail } from '../../lib/email/resend'
import { getNotificationSettings } from '../../lib/notification-settings'
import { appPublicUrl } from '../../lib/notifications'
import { testMessage } from '../../lib/notifications-messages'

/** Sends one email straight to the saved recipient (no outbox), so Settings can show the result. */
export default defineEventHandler(async () => {
  const cfg = emailConfigFromEnv()
  if (!cfg) throw createError({ statusCode: 400, statusMessage: 'RESEND_API_KEY / RESEND_DOMAIN are not set on the server' })
  const { email } = await getNotificationSettings()
  if (!email) throw createError({ statusCode: 400, statusMessage: 'set and save a recipient email first' })
  const m = testMessage(appPublicUrl())
  const res = await sendEmail(cfg, { to: email, subject: m.subject, html: m.bodyHtml, text: m.bodyText, idempotencyKey: m.dedupeKey })
  if (!res.ok) throw createError({ statusCode: 502, statusMessage: res.error })
  return { id: res.id, to: email }
})
