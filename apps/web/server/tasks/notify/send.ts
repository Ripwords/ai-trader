import { drainNotifications } from '../../lib/notifications'
import { createScheduledJob } from '../../lib/scheduler'

// Below the outbox lease (5 min), so a timed-out drain's rows aren't re-claimed while it might still be sending.
const job = createScheduledJob('notify:send', async () => {
  await drainNotifications()
}, { timeoutMs: 4 * 60_000 })

/** Drain the notifications outbox (email via Resend, Web Push), every minute. */
export default defineTask({
  meta: { name: 'notify:send', description: 'Deliver pending notifications by email and push' },
  async run() {
    await job()
    return { result: 'ok' }
  },
})
