import { listAlerts } from '../../lib/alerts'
import { ALERT_STATUSES, type AlertStatus } from '../../lib/alerts-core'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const raw = typeof q.status === 'string' ? q.status : undefined
  let status: AlertStatus | undefined
  if (raw && raw !== 'all') {
    if (!(ALERT_STATUSES as readonly string[]).includes(raw)) {
      throw createError({ statusCode: 400, statusMessage: `invalid status: ${raw}` })
    }
    status = raw as AlertStatus
  }
  return { alerts: await listAlerts({ status }) }
})
