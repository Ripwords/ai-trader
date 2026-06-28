import { defineEventHandler } from 'h3'
import { getOwnerId } from '../../db/repo'
import { getActiveRuns } from '../../lib/agents/runs-query'

const RECENTLY_FINISHED_MS = 3 * 60_000

export default defineEventHandler(async () => {
  const userId = await getOwnerId()
  return getActiveRuns(userId, RECENTLY_FINISHED_MS)
})
