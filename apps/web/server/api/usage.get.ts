import { getLlmUsageSummary, getOwnerId, listLlmUsage } from '../db/repo'
import { getAlphaVantageQuota } from '../lib/alpha-vantage'
import { getNotificationSettings } from '../lib/notification-settings'

export default defineEventHandler(async () => {
  const [ownerId, { timezone }] = await Promise.all([getOwnerId(), getNotificationSettings()])
  const [summary, recent, alphaVantage] = await Promise.all([
    // "today" starts at midnight in the zone set under Settings → Notifications.
    getLlmUsageSummary(ownerId, timezone),
    listLlmUsage(ownerId, { limit: 50 }),
    getAlphaVantageQuota(),
  ])
  return { summary, recent, dataQuotas: { alphaVantage } }
})
