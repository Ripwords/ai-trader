import { appPublicUrl } from '../../lib/notifications'
import { pushPayload, testMessage } from '../../lib/notifications-messages'
import { deletePushSubscriptionById, listPushTargets, markPushSubscriptionOk } from '../../lib/push/subscriptions'
import { pushConfigFromEnv, sendPush } from '../../lib/push/web-push'

/** Pushes a test to every subscribed device directly (no outbox) and reports per-device results. */
export default defineEventHandler(async () => {
  const cfg = pushConfigFromEnv()
  if (!cfg) throw createError({ statusCode: 503, statusMessage: 'VAPID keys are not set on the server' })
  const targets = await listPushTargets()
  if (targets.length === 0) throw createError({ statusCode: 400, statusMessage: 'no device is subscribed' })
  const payload = pushPayload(testMessage(appPublicUrl()))
  let sent = 0
  let removed = 0
  const errors: string[] = []
  for (const t of targets) {
    const res = await sendPush(cfg, t, payload)
    if (res.result === 'sent') {
      sent++
      await markPushSubscriptionOk(t.id, new Date())
    }
    else if (res.result === 'gone') {
      removed++
      await deletePushSubscriptionById(t.id)
    }
    else errors.push(res.error)
  }
  return { sent, removed, errors }
})
