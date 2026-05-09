import { getLlmUsageSummary, getOwnerId, listLlmUsage } from '../db/repo'

export default defineEventHandler(async () => {
  const ownerId = await getOwnerId()
  const [summary, recent] = await Promise.all([
    getLlmUsageSummary(ownerId),
    listLlmUsage(ownerId, { limit: 50 }),
  ])
  return { summary, recent }
})
