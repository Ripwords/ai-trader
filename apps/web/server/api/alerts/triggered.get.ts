import { getTriggeredAlerts } from '../../lib/alerts'

// Without ?since= we return the recent window only — enough for the watcher
// to catch triggers it hasn't notified about, without replaying history.
const DEFAULT_WINDOW_MS = 10 * 60_000

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const raw = typeof q.since === 'string' ? q.since : undefined
  let since = new Date(Date.now() - DEFAULT_WINDOW_MS)
  if (raw) {
    const parsed = new Date(/^\d+$/.test(raw) ? Number(raw) : raw)
    if (Number.isNaN(parsed.getTime())) {
      throw createError({ statusCode: 400, statusMessage: `invalid since: ${raw}` })
    }
    since = parsed
  }
  return getTriggeredAlerts(since)
})
