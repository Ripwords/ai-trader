import type { PortfolioCorrelationResult } from '../../lib/portfolio-correlation-core'
import { getPortfolioCorrelationCached } from '../../lib/portfolio-correlation'

export default defineEventHandler(async (event): Promise<PortfolioCorrelationResult> => {
  const force = Boolean(getQuery(event).force)
  return getPortfolioCorrelationCached({ force })
})
