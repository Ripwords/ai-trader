import type { Order } from '../../llm/http'
import { getApiClient } from '../../llm/http'

/**
 * Proxy to the api container's GET /trade/orders/history. Session-auth via
 * server/middleware/auth.ts; the internal bearer is attached by getApiClient.
 * start/end are YYYY-MM-DD; the api defaults to the last 30 days.
 */
export default defineEventHandler(async (event): Promise<Order[]> => {
  const q = getQuery(event)
  const accId = typeof q.acc_id === 'string' ? q.acc_id : ''
  if (!accId) {
    throw createError({ statusCode: 400, statusMessage: 'acc_id is required' })
  }
  return getApiClient().listHistoryOrders({
    acc_id: accId,
    trd_env: q.trd_env === 'SIMULATE' ? 'SIMULATE' : 'REAL',
    start: typeof q.start === 'string' && q.start ? q.start : undefined,
    end: typeof q.end === 'string' && q.end ? q.end : undefined,
    code: typeof q.code === 'string' && q.code ? q.code : undefined,
  })
})
