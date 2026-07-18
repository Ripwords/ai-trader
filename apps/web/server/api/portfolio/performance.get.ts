import { getPortfolioPerformance, type PortfolioPerformance } from '../../lib/portfolio-history'

/**
 * Equity curve + derived stats from stored portfolio snapshots.
 * Session-auth like the other /api/portfolio routes. ?days=N bounds the
 * window (default 365).
 */
export default defineEventHandler(async (event): Promise<PortfolioPerformance> => {
  const daysRaw = Number(getQuery(event).days)
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.floor(daysRaw) : 365
  return getPortfolioPerformance({ days })
})
