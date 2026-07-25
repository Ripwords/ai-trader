import { requireInternalBearer } from '../_guard'
import { capturePortfolioSnapshot, type CaptureResult } from '../../../lib/portfolio-history'
import { captureInvestmentSnapshot, withDeadline, type InvestmentCaptureResult } from '../../../lib/investment-history'

/**
 * The net-worth capture reaches moomoo (via resolvePortfolio) and Ghostfolio,
 * neither of which has a client-side timeout. With OpenD down it blocks on
 * OpenD's reconnect loop, wedging the daily cron. Ghostfolio can legitimately
 * be slow, so this budget is looser than the investments one.
 */
const NET_WORTH_READ_TIMEOUT_MS = 60_000

interface CombinedCaptureResult extends CaptureResult {
  /**
   * The investments-layer capture, recorded separately from net worth. null
   * when it could not be taken (moomoo live unreachable, FX unresolved) —
   * a missing investments snapshot must never be filled in from net worth.
   */
  investments: InvestmentCaptureResult | null
  investmentsError: string | null
}

/**
 * Bearer-gated snapshot capture for the cron container. Defaults to
 * source=auto, which is idempotent per UTC day — the cron loop can fire more
 * than once without duplicating the equity curve. Pass {"source":"manual"}
 * to force an insert (the session-authed wrapper route does this).
 *
 * Captures BOTH layers: net worth (Ghostfolio) and investments (moomoo live).
 * They are stored in separate tables and either can fail independently; a
 * failed investments capture never fails the request, it is reported instead.
 */
export default defineEventHandler(async (event): Promise<CombinedCaptureResult> => {
  requireInternalBearer(event)
  const body = await readBody<{ source?: string } | undefined>(event).catch(() => undefined)
  const source = body?.source === 'manual' ? 'manual' : 'auto'

  const investmentsResult = await captureInvestmentSnapshot(source).then(
    r => ({ ok: true as const, value: r }),
    (err: unknown) => ({ ok: false as const, message: err instanceof Error ? err.message : String(err) }),
  )
  if (!investmentsResult.ok) {
    console.warn('[capture-snapshot] investments layer not recorded:', investmentsResult.message)
  }

  try {
    const netWorth = await withDeadline(
      capturePortfolioSnapshot(source), NET_WORTH_READ_TIMEOUT_MS, 'net worth read',
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
