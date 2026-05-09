import { getApiClient } from '../../llm/http'
import type { ApiClient } from '../../llm/http'
import type { SynthesisRequest, SynthesisResponse } from '../../../types/research'

interface PortfolioSnapshot {
  cash: number
  total_value: number
  positions: Record<string, number>
}

async function fetchSimulatePortfolio(client: ApiClient): Promise<PortfolioSnapshot> {
  const accounts = await client.listAccounts()
  const acct = accounts.find(a => a.trd_env === 'SIMULATE' && a.acc_role !== 'IPO')
  if (!acct) {
    return { cash: 0, total_value: 0, positions: {} }
  }
  const p = await client.getPortfolio({ acc_id: acct.acc_id, trd_env: 'SIMULATE' })
  const positions: Record<string, number> = {}
  for (const pos of p.positions) {
    positions[pos.code] = pos.market_val
  }
  return { cash: p.cash, total_value: p.total_assets, positions }
}

export default defineEventHandler(async (event): Promise<SynthesisResponse> => {
  const body = await readBody<SynthesisRequest>(event)
  if (!body || !Array.isArray(body.signals) || body.signals.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'signals required' })
  }
  const symbols = Array.isArray(body.symbols) && body.symbols.length > 0
    ? body.symbols
    : Array.from(new Set(body.signals.map(s => s.symbol)))

  const client = getApiClient()
  const portfolio = (body.portfolio as PortfolioSnapshot | undefined) ?? await fetchSimulatePortfolio(client)

  return client.post<SynthesisResponse>('/synthesis/decide', {
    symbols,
    signals: body.signals,
    portfolio,
  })
})
