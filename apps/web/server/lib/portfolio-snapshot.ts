import { getApiClient } from '../llm/http'
import type { ApiClient } from '../llm/http'
import { getFullPortfolio } from './holdings'

export interface PortfolioSnapshot {
  cash: number
  total_value: number
  positions: Record<string, number>
}

async function tryMoomooPortfolio(client: ApiClient): Promise<PortfolioSnapshot | null> {
  try {
    const accounts = await client.listAccounts()
    const acct = accounts.find(a => a.trd_env === 'SIMULATE' && a.acc_role !== 'IPO')
    if (!acct) return null
    const p = await client.getPortfolio({ acc_id: acct.acc_id, trd_env: 'SIMULATE' })
    const positions: Record<string, number> = {}
    for (const pos of p.positions) {
      positions[pos.code] = pos.market_val
    }
    return { cash: p.cash, total_value: p.total_assets, positions }
  } catch (err) {
    console.warn('[portfolio-snapshot] moomoo unavailable:', err instanceof Error ? err.message : err)
    return null
  }
}

async function tryGhostfolioPortfolio(): Promise<PortfolioSnapshot | null> {
  try {
    const full = await getFullPortfolio()
    if (full.ghostfolio_status !== 'ok' || full.net_worth_total == null) return null
    const positions: Record<string, number> = {}
    for (const pos of full.positions) {
      positions[pos.symbol] = pos.market_value
    }
    return {
      cash: full.cash_total ?? 0,
      total_value: full.net_worth_total,
      positions,
    }
  } catch (err) {
    console.warn('[portfolio-snapshot] ghostfolio unavailable:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Best-effort portfolio fetch for synthesis sizing. Tries moomoo SIMULATE
 * first (live trade port), falls back to Ghostfolio's aggregate, throws a
 * 503-style error when both are offline so callers can surface a clear
 * "connect a portfolio source" message instead of a downstream 422.
 */
export async function resolvePortfolio(client: ApiClient = getApiClient()): Promise<PortfolioSnapshot> {
  const moomoo = await tryMoomooPortfolio(client)
  if (moomoo) return moomoo
  const ghos = await tryGhostfolioPortfolio()
  if (ghos) return ghos
  throw createError({
    statusCode: 503,
    statusMessage:
      'no portfolio data — moomoo trade login is offline and Ghostfolio is unavailable. Connect either to size decisions.',
  })
}
