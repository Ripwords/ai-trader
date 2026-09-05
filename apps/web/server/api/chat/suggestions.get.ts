import { getApiClient } from '../../llm/http'
import { peekFullPortfolio } from '../../lib/portfolio-cache'
import { getTriggeredAlerts } from '../../lib/alerts'
import { buildSuggestions, type SuggestionSources } from '../../lib/chat-suggestions'

// The landing page must never wait on a slow source. Watchlist and alerts get
// this long; the portfolio is only ever read from its cache.
const SOURCE_TIMEOUT_MS = 1500
const TRIGGERED_WINDOW_MS = 24 * 60 * 60 * 1000

function within<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), SOURCE_TIMEOUT_MS)
  })
  return Promise.race([work.catch(() => fallback), late]).finally(() => clearTimeout(timer))
}

export default defineEventHandler(async (): Promise<{ suggestions: string[] }> => {
  const [watch, portfolio, alerts] = await Promise.all([
    within(getApiClient().listWatchlist({ group: 'All' }), []),
    within(peekFullPortfolio(), null),
    within(getTriggeredAlerts(new Date(Date.now() - TRIGGERED_WINDOW_MS)), null),
  ])

  const sources: SuggestionSources = {
    watchlist: watch.map(w => ({ code: w.code, name: w.name })),
    positions: [
      ...(portfolio?.positions ?? [])
        .filter(p => p.asset_class === 'EQUITY')
        .map(p => ({ symbol: p.symbol, name: p.name, pnlPct: p.pnl_pct })),
      ...(portfolio?.moomoo_live ?? []).map(p => ({ symbol: p.symbol, name: null, pnlPct: p.pnl_pct })),
      ...(portfolio?.moomoo_paper ?? []).map(p => ({ symbol: p.symbol, name: null, pnlPct: p.pnl_pct })),
    ],
    triggeredAlerts: (alerts?.triggered ?? []).map(a => ({ symbol: a.symbol })),
  }
  return { suggestions: buildSuggestions(sources) }
})
