import { capturePortfolioSnapshot, type CaptureResult } from '../../lib/portfolio-history'

/**
 * Session-authed wrapper over the snapshot capture (auth handled by
 * server/middleware/auth.ts like every /api/portfolio route). Used by the
 * portfolio page's "capture" button — always records a manual snapshot,
 * bypassing the auto once-per-day idempotency.
 */
export default defineEventHandler(async (): Promise<CaptureResult> => {
  try {
    return await capturePortfolioSnapshot('manual')
  } catch (err) {
    throw createError({
      statusCode: 503,
      statusMessage: err instanceof Error ? err.message : 'portfolio snapshot capture failed',
    })
  }
})
