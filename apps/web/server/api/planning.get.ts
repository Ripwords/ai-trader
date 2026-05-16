import { getFullPortfolioCached } from '../lib/portfolio-cache'
import { buildPlanningSummary, type PlanningSummary } from '../lib/planning'
import { getPlanningSettings } from '../lib/planning-settings'

// The expensive leg (cross-broker portfolio) is cached + coalesced in
// getFullPortfolioCached, shared with /api/portfolio so a cold page load
// fetches it once. buildPlanningSummary is a pure, cheap transform so the
// endpoint itself needs no extra cache. ?force=1 (hard-refresh)
// invalidates the shared portfolio cache.
export default defineEventHandler(async (event): Promise<PlanningSummary> => {
  const force = Boolean(getQuery(event).force)
  const [portfolio, settings] = await Promise.all([
    getFullPortfolioCached({ force }),
    getPlanningSettings(),
  ])
  return buildPlanningSummary(portfolio, settings)
})
