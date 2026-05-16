import type { FullPortfolio } from '../lib/holdings'
import { getFullPortfolioCached } from '../lib/portfolio-cache'

// Caching + concurrent-request coalescing live in getFullPortfolioCached
// (SWR: fresh 60s, stale up to 10min while revalidating). That same shared
// function cache backs /api/planning, so a cold page load runs the
// expensive cross-broker fetch once instead of twice. The page's refresh
// button passes ?force=1 to invalidate and recompute.
export default defineEventHandler(async (event): Promise<FullPortfolio> => {
  const force = Boolean(getQuery(event).force)
  return getFullPortfolioCached({ force })
})
