import { getLlmUsageSummary, getOwnerId, listLlmUsage } from '../db/repo'
import { getAlphaVantageQuota } from '../lib/alpha-vantage'

export default defineEventHandler(async () => {
  const ownerId = await getOwnerId()
  const [summary, recent, alphaVantage] = await Promise.all([
    getLlmUsageSummary(ownerId),
    listLlmUsage(ownerId, { limit: 50 }),
    getAlphaVantageQuota(),
  ])
  return { summary, recent, dataQuotas: { alphaVantage } }
})
