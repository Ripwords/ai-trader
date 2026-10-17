import { dispatchDueReminders } from '../../lib/reminders'
import { kickNotifications } from '../../lib/notifications'
import { createScheduledJob } from '../../lib/scheduler'

const job = createScheduledJob('reminders:dispatch', async () => {
  const sent = await dispatchDueReminders()
  if (sent.length > 0) kickNotifications()
}, { timeoutMs: 2 * 60_000 })

/** Due reminders → outbox, every minute; then nudges the sender so they go out this minute. */
export default defineTask({
  meta: { name: 'reminders:dispatch', description: 'Enqueue notifications for reminders that came due' },
  async run() {
    await job()
    return { result: 'ok' }
  },
})
