import { listReminders } from '../../lib/reminders'
import { REMINDER_STATUSES, type ReminderStatus } from '../../lib/reminders-core'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const raw = typeof q.status === 'string' ? q.status : undefined
  let status: ReminderStatus | undefined
  if (raw && raw !== 'all') {
    if (!(REMINDER_STATUSES as readonly string[]).includes(raw)) {
      throw createError({ statusCode: 400, statusMessage: `invalid status: ${raw}` })
    }
    status = raw as ReminderStatus
  }
  return { reminders: await listReminders({ status }) }
})
