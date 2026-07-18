import { requireInternalBearer } from '../_guard'
import { capturePortfolioSnapshot, type CaptureResult } from '../../../lib/portfolio-history'

/**
 * Bearer-gated snapshot capture for the cron container. Defaults to
 * source=auto, which is idempotent per UTC day — the cron loop can fire more
 * than once without duplicating the equity curve. Pass {"source":"manual"}
 * to force an insert (the session-authed wrapper route does this).
 */
export default defineEventHandler(async (event): Promise<CaptureResult> => {
  requireInternalBearer(event)
  const body = await readBody<{ source?: string } | undefined>(event).catch(() => undefined)
  const source = body?.source === 'manual' ? 'manual' : 'auto'
  try {
    return await capturePortfolioSnapshot(source)
  } catch (err) {
    throw createError({
      statusCode: 503,
      statusMessage: err instanceof Error ? err.message : 'portfolio snapshot capture failed',
    })
  }
})
