import { getOwnerId } from '../../db/repo'
import { assembleRiskReport } from '../../lib/risk-report'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const symbol = String(q.symbol ?? '').trim()
  if (!symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol is required' })
  }
  const refresh = q.refresh === '1' || q.refresh === 'true'
  const ownerId = await getOwnerId()
  try {
    const report = await assembleRiskReport({ ownerId, symbol, refresh })
    return report
  } catch (err) {
    console.error('[deep-report] failed', symbol, err)
    const message = err instanceof Error ? err.message : 'failed to generate risk report'
    throw createError({ statusCode: 502, statusMessage: message })
  }
})
