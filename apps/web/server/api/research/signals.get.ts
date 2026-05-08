import { getOwnerId, listResearchSignals } from '../../db/repo'
import type { Signal } from '../../../types/research'

export default defineEventHandler(async (event): Promise<{ signals: Signal[] }> => {
  const q = getQuery(event)
  const symbol = typeof q.symbol === 'string' ? q.symbol : undefined
  const limit = typeof q.limit === 'string' ? Number(q.limit) : 50

  const ownerId = await getOwnerId()
  const signals = await listResearchSignals(ownerId, { symbol, limit })
  return { signals }
})
