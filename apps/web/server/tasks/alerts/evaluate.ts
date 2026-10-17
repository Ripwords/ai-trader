import { getApiClient } from '../../llm/http'
import { runAlertEvaluation } from '../../lib/alerts-evaluate'
import { getInvestmentPortfolio } from '../../lib/investment-portfolio'
import type { AlertPosition } from '../../lib/price-alert-message'
import { kickNotifications } from '../../lib/notifications'
import { createScheduledJob } from '../../lib/scheduler'

/** The live moomoo holding of `symbol`, for the alert email's "Your position" block. */
async function findPosition(symbol: string): Promise<AlertPosition | null> {
  const p = (await getInvestmentPortfolio()).positions.find(pos => pos.symbol === symbol)
  if (!p || p.qty === 0) return null
  return {
    quantity: p.qty,
    avgCost: p.cost_price || null,
    unrealizedPl: p.unrealized_pl,
    unrealizedPlPct: p.unrealized_pl_pct,
    currency: p.currency,
  }
}

// Snapshots each time out on their own; this bounds the whole pass, DB included.
const job = createScheduledJob('alerts:evaluate', async () => {
  const api = getApiClient()
  const { triggered } = await runAlertEvaluation({
    getSnapshot: args => api.getSnapshot(args),
    getKline: args => api.getKline(args),
    findPosition,
  })
  if (triggered > 0) kickNotifications()
}, { timeoutMs: 5 * 60_000 })

/**
 * Price alerts, every minute (nitro.scheduledTasks in nuxt.config.ts).
 * PRICE_ALERTS_DISABLED=1 turns it off (tests, one-off scripts); it then
 * leaves no heartbeat, so Settings shows the check as stale.
 */
export default defineTask({
  meta: { name: 'alerts:evaluate', description: 'Check armed price alerts against live quotes' },
  async run() {
    if (process.env.PRICE_ALERTS_DISABLED === '1') return { result: 'disabled' }
    await job()
    return { result: 'ok' }
  },
})
