import { callGhostfolioTool, getGhostfolioStatus, type GhostfolioStatus } from '../llm/mcp'
import { getApiClient } from '../llm/http'
import type { Account, Portfolio, Position } from '../llm/http'
import { toYahooSymbol } from './yahoo'

export interface HoldingPosition {
  source: 'ghostfolio' | 'moomoo_live' | 'moomoo_paper'
  symbol: string
  quantity: number
  avg_cost: number | null
  current_price: number | null
  market_value: number | null
  unrealized_pnl_pct: number | null
  account_label: string
}

export interface HoldingSummary {
  symbol: string
  positions: HoldingPosition[]
  total_quantity: number
  total_market_value: number
  net_worth_total: number | null
  allocation_pct: number | null
  cash_paper_usd: number
  cash_live_usd: number
  ghostfolio_status: GhostfolioStatus
}

/**
 * Strip the moomoo market prefix (`US.`, `HK.`, etc.) for matching against
 * Ghostfolio symbols, which are typically bare tickers (`NVDA`, not `US.NVDA`).
 */
function stripMarketPrefix(code: string): string {
  const dot = code.indexOf('.')
  return dot >= 0 ? code.slice(dot + 1) : code
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

function toNumber(x: unknown): number | null {
  if (typeof x === 'number' && Number.isFinite(x)) return x
  if (typeof x === 'string') {
    const n = Number(x)
    return Number.isFinite(n) ? n : null
  }
  return null
}

interface MoomooSlice {
  positions: HoldingPosition[]
  total_market_value: number
  cash_paper_usd: number
  cash_live_usd: number
  // total paper-account value across ALL paper positions (used for portfolio sizing)
  paper_total_value: number
  paper_positions_by_symbol: Record<string, number>
}

async function fetchMoomooSlice(symbol: string): Promise<MoomooSlice> {
  const empty: MoomooSlice = {
    positions: [],
    total_market_value: 0,
    cash_paper_usd: 0,
    cash_live_usd: 0,
    paper_total_value: 0,
    paper_positions_by_symbol: {},
  }
  let client: ReturnType<typeof getApiClient>
  try {
    client = getApiClient()
  } catch {
    return empty
  }

  let accounts: Account[]
  try {
    accounts = await client.listAccounts()
  } catch (err) {
    console.warn('[holdings] moomoo listAccounts failed:', err instanceof Error ? err.message : String(err))
    return empty
  }

  const tradingAccounts = accounts.filter(a => a.acc_role !== 'IPO')
  const out: MoomooSlice = { ...empty, paper_positions_by_symbol: {} }

  await Promise.all(
    tradingAccounts.map(async (acc) => {
      try {
        const portfolio: Portfolio = await client.getPortfolio({ acc_id: acc.acc_id, trd_env: acc.trd_env })
        const isPaper = acc.trd_env === 'SIMULATE'
        if (isPaper) {
          out.cash_paper_usd += portfolio.cash || 0
          out.paper_total_value += portfolio.total_assets || 0
          for (const p of portfolio.positions) {
            const bare = stripMarketPrefix(p.code)
            out.paper_positions_by_symbol[bare] = (out.paper_positions_by_symbol[bare] ?? 0) + (p.market_val || 0)
          }
        } else {
          out.cash_live_usd += portfolio.cash || 0
        }

        const matches = portfolio.positions.filter((p: Position) => {
          return p.code === symbol || stripMarketPrefix(p.code) === stripMarketPrefix(symbol)
        })
        for (const p of matches) {
          out.positions.push({
            source: isPaper ? 'moomoo_paper' : 'moomoo_live',
            symbol: p.code,
            quantity: p.qty,
            avg_cost: p.cost_price,
            current_price: p.current_price,
            market_value: p.market_val,
            unrealized_pnl_pct: p.pl_ratio,
            account_label: isPaper ? 'Moomoo Paper' : 'Moomoo Live',
          })
          out.total_market_value += p.market_val || 0
        }
      } catch (err) {
        console.warn(`[holdings] moomoo getPortfolio failed for ${acc.acc_id}:`, err instanceof Error ? err.message : String(err))
      }
    }),
  )

  return out
}

interface GhostfolioSlice {
  positions: HoldingPosition[]
  total_market_value: number
  net_worth_total: number | null
  status: GhostfolioStatus
}

// Verified against the user's mhajder/ghostfolio-mcp server. Older Ghostfolio
// MCP forks may use camelCase aliases — we keep those as fallbacks but try
// the canonical snake_case names first.
const GHOSTFOLIO_HOLDINGS_TOOL_CANDIDATES = ['get_portfolio_holdings', 'getHoldings', 'holdings']
const GHOSTFOLIO_DETAILS_TOOL_CANDIDATES = ['get_portfolio_details', 'getPortfolioDetails']

async function fetchGhostfolioSlice(symbol: string): Promise<GhostfolioSlice> {
  const status = await getGhostfolioStatus()
  if (status !== 'ok') {
    return { positions: [], total_market_value: 0, net_worth_total: null, status }
  }

  // Ghostfolio uses Yahoo-style symbols (NVDA, 0700.HK, 600519.SS, 0828EA.KL).
  // Translate the moomoo input to that format for matching.
  const targetYf = toYahooSymbol(symbol)
  let raw: unknown = null
  let lastErr: unknown = null

  for (const name of GHOSTFOLIO_HOLDINGS_TOOL_CANDIDATES) {
    try {
      raw = await callGhostfolioTool(name, {})
      if (raw) break
    } catch (err) {
      lastErr = err
    }
  }

  if (raw == null) {
    if (lastErr) console.warn('[holdings] ghostfolio holdings tool probe failed:', lastErr instanceof Error ? lastErr.message : String(lastErr))
    return { positions: [], total_market_value: 0, net_worth_total: null, status: 'failing' }
  }

  let holdingsArr: unknown[] = []
  if (Array.isArray(raw)) holdingsArr = raw
  else if (isRecord(raw)) {
    for (const k of ['holdings', 'positions', 'items', 'data']) {
      if (Array.isArray(raw[k])) {
        holdingsArr = raw[k] as unknown[]
        break
      }
    }
  }

  // Net worth lives in get_portfolio_details.summary.totalValueInBaseCurrency.
  // Fall back to currentValueInBaseCurrency / fireWealth.today if missing.
  let netWorthTotal: number | null = null
  for (const name of GHOSTFOLIO_DETAILS_TOOL_CANDIDATES) {
    try {
      const details = await callGhostfolioTool(name, {})
      if (isRecord(details)) {
        const summary = isRecord(details.summary) ? details.summary : null
        if (summary) {
          netWorthTotal = toNumber(summary.totalValueInBaseCurrency)
            ?? toNumber(summary.currentValueInBaseCurrency)
            ?? null
          if (netWorthTotal == null && isRecord(summary.fireWealth) && isRecord(summary.fireWealth.today)) {
            netWorthTotal = toNumber(summary.fireWealth.today.valueInBaseCurrency)
          }
          if (netWorthTotal != null) break
        }
      }
    } catch {
      // best-effort
    }
  }

  const positions: HoldingPosition[] = []
  let totalMv = 0
  for (const h of holdingsArr) {
    if (!isRecord(h)) continue
    const sym = String(h.symbol ?? h.code ?? h.ticker ?? '')
    if (!sym || sym !== targetYf) continue

    const qty = toNumber(h.quantity) ?? toNumber(h.qty) ?? 0
    const mv = toNumber(h.valueInBaseCurrency) ?? toNumber(h.marketValue) ?? toNumber(h.value) ?? null
    const investment = toNumber(h.investment)
    const avg = qty > 0 && investment != null ? investment / qty : null
    const cur = toNumber(h.marketPrice) ?? toNumber(h.currentPrice) ?? null
    const pnlPctRaw = toNumber(h.netPerformancePercent) ?? toNumber(h.netPerformancePercentWithCurrencyEffect)
    // Ghostfolio returns 0.4753 for "+47.53%"; normalize to percent for display.
    const pnlPct = pnlPctRaw != null ? pnlPctRaw * 100 : null

    positions.push({
      source: 'ghostfolio',
      symbol: sym,
      quantity: qty,
      avg_cost: avg,
      current_price: cur,
      market_value: mv,
      unrealized_pnl_pct: pnlPct,
      account_label: String(h.name ?? 'Ghostfolio'),
    })
    if (mv != null) totalMv += mv
  }

  return { positions, total_market_value: totalMv, net_worth_total: netWorthTotal, status: 'ok' }
}

export async function getHoldingForSymbol(symbol: string): Promise<HoldingSummary> {
  const [ghosRes, moomooRes] = await Promise.allSettled([
    fetchGhostfolioSlice(symbol),
    fetchMoomooSlice(symbol),
  ])

  const ghos: GhostfolioSlice = ghosRes.status === 'fulfilled'
    ? ghosRes.value
    : { positions: [], total_market_value: 0, net_worth_total: null, status: 'failing' }

  const moomoo: MoomooSlice = moomooRes.status === 'fulfilled'
    ? moomooRes.value
    : { positions: [], total_market_value: 0, cash_paper_usd: 0, cash_live_usd: 0, paper_total_value: 0, paper_positions_by_symbol: {} }

  const positions = [...ghos.positions, ...moomoo.positions]
  const total_market_value = ghos.total_market_value + moomoo.total_market_value
  const total_quantity = positions.reduce((sum, p) => sum + (p.quantity || 0), 0)
  const allocation_pct = ghos.net_worth_total && ghos.net_worth_total > 0
    ? (total_market_value / ghos.net_worth_total) * 100
    : null

  return {
    symbol,
    positions,
    total_quantity,
    total_market_value,
    net_worth_total: ghos.net_worth_total,
    allocation_pct,
    cash_paper_usd: moomoo.cash_paper_usd,
    cash_live_usd: moomoo.cash_live_usd,
    ghostfolio_status: ghos.status,
  }
}

export interface PaperPortfolioSlice {
  cash_paper_usd: number
  paper_total_value: number
  paper_positions_by_symbol: Record<string, number>
}

/**
 * Lower-level fetch that returns the full paper-account picture, used by
 * the synthesize step to size trades against actual paper cash + positions
 * rather than a hardcoded $100k.
 */
export async function getPaperPortfolioSlice(): Promise<PaperPortfolioSlice> {
  // Pass an empty symbol — we only want the aggregates, not symbol-matched positions.
  const slice = await fetchMoomooSlice('')
  return {
    cash_paper_usd: slice.cash_paper_usd,
    paper_total_value: slice.paper_total_value,
    paper_positions_by_symbol: slice.paper_positions_by_symbol,
  }
}
