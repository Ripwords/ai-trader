import { getFullPortfolio } from '../../../lib/holdings'
import { buildPlanningSnapshot, buildPlanningSummary } from '../../../lib/planning'
import { appendPlanningSnapshot, getPlanningSettings } from '../../../lib/planning-settings'

export default defineEventHandler(async () => {
  const [portfolio, settings] = await Promise.all([
    getFullPortfolio(),
    getPlanningSettings(),
  ])
  const summary = buildPlanningSummary(portfolio, settings)
  const snapshot = buildPlanningSnapshot(summary)
  const history = await appendPlanningSnapshot(snapshot)

  return { snapshot, history }
})
