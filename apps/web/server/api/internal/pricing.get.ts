import { defineEventHandler } from 'h3'
import { requireInternalBearer } from './_guard'
import { MODEL_PRICING } from '../../lib/model-pricing'

/**
 * The TradingAgents toolkit / cost-cap layer reads this to estimate $/run
 * without round-tripping to the Python api. The rates live in
 * server/lib/model-pricing.ts, shared with the cost estimator so the two
 * cannot drift apart again.
 */
export default defineEventHandler((event) => {
  requireInternalBearer(event)
  return { models: MODEL_PRICING }
})
