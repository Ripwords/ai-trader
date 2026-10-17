import { pushConfigFromEnv } from '../../lib/push/web-push'

export default defineEventHandler(() => {
  const cfg = pushConfigFromEnv()
  if (!cfg) throw createError({ statusCode: 503, statusMessage: 'VAPID keys are not set on the server' })
  return { publicKey: cfg.publicKey }
})
