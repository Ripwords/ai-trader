import { capturePortfolioSnapshot, type CaptureResult } from '../../lib/portfolio-history'
import { captureInvestmentSnapshot, withDeadline, type InvestmentCaptureResult } from '../../lib/investment-history'

/** See the internal route: neither upstream read has a client-side timeout. */
const NET_WORTH_READ_TIMEOUT_MS = 60_000

interface CombinedCaptureResult extends CaptureResult {
  investments: InvestmentCaptureResult | null
  investmentsError: string | null
}

/**
 * Session-authed wrapper over the snapshot capture (auth handled by
 * server/middleware/auth.ts like every /api/portfolio route). Used by the
 * portfolio page's "capture" button — always records a manual snapshot,
 * bypassing the auto once-per-day idempotency. Captures both layers; a failed
 * investments capture is reported rather than failing the request.
 */
export default defineEventHandler(async (): Promise<CombinedCaptureResult> => {
  const investmentsResult = await captureInvestmentSnapshot('manual').then(
    r => ({ ok: true as const, value: r }),
    (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
  )
  try {
    const netWorth = await withDeadline(
      capturePortfolioSnapshot('manual'), NET_WORTH_READ_TIMEOUT_MS, 'net worth read',
    )
    return {
      ...netWorth,
      investments: investmentsResult.ok ? investmentsResult.value : null,
      investmentsError: investmentsResult.ok ? null : investmentsResult.message,
    }
  } catch (err) {
    throw createError({
      statusCode: 503,
      statusMessage: err instanceof Error ? err.message : 'portfolio snapshot capture failed',
    })
  }
})
