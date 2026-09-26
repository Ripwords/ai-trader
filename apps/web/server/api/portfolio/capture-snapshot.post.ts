import { createError, defineEventHandler, readBody } from 'h3'
import { capturePortfolioSnapshot, type CaptureResult } from '../../lib/portfolio-history'
import { captureInvestmentSnapshot, withDeadline, type InvestmentCaptureResult } from '../../lib/investment-history'

/**
 * The net-worth capture reaches Ghostfolio and moomoo (for the broker slices
 * stored alongside), neither of which has a client-side timeout. With OpenD
 * down it blocks on OpenD's reconnect loop. Ghostfolio can legitimately be
 * slow, so this budget is looser than the investments one.
 */
const NET_WORTH_READ_TIMEOUT_MS = 60_000

export interface CombinedCaptureResult extends CaptureResult {
  /**
   * The investments-layer capture, recorded separately from net worth. null
   * when it could not be taken (moomoo live unreachable, FX unresolved) —
   * a missing investments snapshot must never be filled in from net worth.
   */
  investments: InvestmentCaptureResult | null
  investmentsError: string | null
}

/**
 * Session-authed snapshot capture (auth handled by server/middleware/auth.ts
 * like every /api/portfolio route). Two callers:
 * - the portfolio page on load posts {"source":"auto"}: idempotent per UTC
 *   day, so it records at most one auto snapshot a day however often the
 *   page is opened;
 * - the page's "capture" button posts no body: a manual snapshot that always
 *   inserts.
 *
 * Captures BOTH layers: net worth (Ghostfolio) and investments (moomoo live).
 * They are stored in separate tables and either can fail independently; a
 * failed investments capture never fails the request, it is reported instead.
 */
export default defineEventHandler(async (event): Promise<CombinedCaptureResult> => {
  const body = await readBody<{ source?: string } | undefined>(event).catch(() => undefined)
  const source = body?.source === 'auto' ? 'auto' : 'manual'

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
