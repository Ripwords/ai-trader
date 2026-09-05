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
  // Settlement currency of market_value (e.g. 'USD', 'HKD', 'MYR'). null when
  // the source didn't report it. Never assume USD.
  currency: string | null
}

export interface HoldingSummary {
  symbol: string
  positions: HoldingPosition[]
  owned_quantity: number
  owned_market_value: number
  answer_source: 'moomoo_live' | 'ghostfolio_tracker' | 'none'
  broker_quantity: number
  broker_market_value: number
  paper_quantity: number
  paper_market_value: number
  tracker_quantity: number
  tracker_market_value: number
  total_quantity: number
  total_market_value: number
  net_worth_total: number | null
  // Currency of net_worth_total (Ghostfolio base currency, e.g. 'MYR'). null
  // when Ghostfolio isn't the answer source.
  net_worth_currency: string | null
  allocation_pct: number | null
  allocation_source: 'ghostfolio_tracker' | null
  // Deprecated USD-named aggregates: retained for backward compatibility, but
  // they sum moomoo cash across markets regardless of currency. Prefer the
  // *_by_currency maps, which keep each market's cash in its real currency.
  cash_paper_usd: number
  cash_live_usd: number
  cash_paper_by_currency: Record<string, number>
  cash_live_by_currency: Record<string, number>
  ghostfolio_status: GhostfolioStatus
  reconciliation: {
    status: 'matched' | 'mismatch' | 'not_compared'
    quantity_delta: number | null
    note: string
  }
  value_units_note: string
  // Names of every Ghostfolio account, surfaced for context. Ghostfolio's
  // get_portfolio_holdings aggregates a symbol across all accounts, so we
  // can't attribute per-position without reconstructing from get_orders.
  ghostfolio_accounts: string[]
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
  cash_paper_by_currency: Record<string, number>
  cash_live_by_currency: Record<string, number>
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
    cash_paper_by_currency: {},
    cash_live_by_currency: {},
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
  const out: MoomooSlice = {
    positions: [],
    total_market_value: 0,
    cash_paper_usd: 0,
    cash_live_usd: 0,
    cash_paper_by_currency: {},
    cash_live_by_currency: {},
    paper_total_value: 0,
    paper_positions_by_symbol: {},
  }

  await Promise.all(
    tradingAccounts.map(async (acc) => {
      try {
        const portfolio: Portfolio = await client.getPortfolio({ acc_id: acc.acc_id, trd_env: acc.trd_env })
        const isPaper = acc.trd_env === 'SIMULATE'
        // Group cash by the currencies the user ACTUALLY holds (moomoo's native
        // per-currency cash), not the base/reporting currency. moomoo's scalar
        // `cash` + `currency` is the home-currency (e.g. HKD) conversion of all
        // cash, so using it here would invent a phantom HKD balance for a
        // USD-only account. Fall back to the base scalar only if the native
        // breakdown is missing.
        const nativeCash = portfolio.cash_by_currency && Object.keys(portfolio.cash_by_currency).length > 0
          ? portfolio.cash_by_currency
          : { [portfolio.currency ?? 'UNKNOWN']: portfolio.cash || 0 }
        const cashBucket = isPaper ? out.cash_paper_by_currency : out.cash_live_by_currency
        for (const [ccy, amt] of Object.entries(nativeCash)) {
          cashBucket[ccy] = (cashBucket[ccy] ?? 0) + (amt || 0)
        }
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
            // moomoo reports pl_ratio as a fraction (0.125); this field is a
            // percent so it lines up with the Ghostfolio rows in the same list.
            unrealized_pnl_pct: p.pl_ratio * 100,
            account_label: isPaper ? 'Moomoo Paper' : 'Moomoo Live',
            // Prefer the position's own currency; fall back to the account
            // settlement currency.
            currency: p.currency ?? portfolio.currency ?? null,
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
  // Ghostfolio base currency (e.g. 'MYR') that net_worth_total is denominated in.
  base_currency: string | null
  status: GhostfolioStatus
  account_names: string[]
}

// Verified against the user's mhajder/ghostfolio-mcp server. Older Ghostfolio
// MCP forks may use camelCase aliases — we keep those as fallbacks but try
// the canonical snake_case names first.
const GHOSTFOLIO_HOLDINGS_TOOL_CANDIDATES = ['get_portfolio_holdings', 'getHoldings', 'holdings']
const GHOSTFOLIO_DETAILS_TOOL_CANDIDATES = ['get_portfolio_details', 'getPortfolioDetails']
const GHOSTFOLIO_ACCOUNTS_TOOL_CANDIDATES = ['get_accounts', 'getAccounts']

async function fetchGhostfolioSlice(symbol: string): Promise<GhostfolioSlice> {
  const status = await getGhostfolioStatus()
  if (status !== 'ok') {
    return { positions: [], total_market_value: 0, net_worth_total: null, base_currency: null, status, account_names: [] }
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
    return { positions: [], total_market_value: 0, net_worth_total: null, base_currency: null, status: 'failing', account_names: [] }
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
  let baseCurrency: string | null = null
  for (const name of GHOSTFOLIO_DETAILS_TOOL_CANDIDATES) {
    try {
      const details = await callGhostfolioTool(name, {})
      if (isRecord(details)) {
        const summary = isRecord(details.summary) ? details.summary : null
        if (summary) {
          if (typeof summary.baseCurrency === 'string' && summary.baseCurrency) {
            baseCurrency = summary.baseCurrency
          }
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

  // Best-effort fetch of account names so the agent has cross-broker context
  // (e.g. "you hold this across IBKR + Moomoo accounts"). Per-position
  // attribution would need a get_orders reconstruction — out of scope.
  const account_names: string[] = []
  for (const name of GHOSTFOLIO_ACCOUNTS_TOOL_CANDIDATES) {
    try {
      const acctRes = await callGhostfolioTool(name, {})
      const acctList: unknown = isRecord(acctRes)
        ? (Array.isArray(acctRes.accounts) ? acctRes.accounts : null)
        : (Array.isArray(acctRes) ? acctRes : null)
      if (Array.isArray(acctList)) {
        for (const a of acctList) {
          if (isRecord(a) && typeof a.name === 'string' && a.name) {
            account_names.push(a.name)
          }
        }
        if (account_names.length > 0) break
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
    // Weighted-average cost basis across all accounts holding this symbol.
    // Per-lot granularity would require reconstructing from get_orders.
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
      account_label: 'Ghostfolio (aggregate)',
      // market_value here is valueInBaseCurrency, so its currency is the
      // Ghostfolio base currency (e.g. MYR) — not the asset's native trading
      // currency. Fall back to h.currency only if base is unknown.
      currency: baseCurrency ?? (typeof h.currency === 'string' && h.currency ? h.currency : null),
    })
    if (mv != null) totalMv += mv
  }

  return { positions, total_market_value: totalMv, net_worth_total: netWorthTotal, base_currency: baseCurrency, status: 'ok', account_names }
}

export async function getHoldingForSymbol(symbol: string): Promise<HoldingSummary> {
  const [ghosRes, moomooRes] = await Promise.allSettled([
    fetchGhostfolioSlice(symbol),
    fetchMoomooSlice(symbol),
  ])

  const ghos: GhostfolioSlice = ghosRes.status === 'fulfilled'
    ? ghosRes.value
    : { positions: [], total_market_value: 0, net_worth_total: null, base_currency: null, status: 'failing', account_names: [] }

  const moomoo: MoomooSlice = moomooRes.status === 'fulfilled'
    ? moomooRes.value
    : { positions: [], total_market_value: 0, cash_paper_usd: 0, cash_live_usd: 0, cash_paper_by_currency: {}, cash_live_by_currency: {}, paper_total_value: 0, paper_positions_by_symbol: {} }

  const positions = [...ghos.positions, ...moomoo.positions]
  const brokerPositions = moomoo.positions.filter(p => p.source === 'moomoo_live')
  const paperPositions = moomoo.positions.filter(p => p.source === 'moomoo_paper')
  const trackerPositions = ghos.positions

  const sumQty = (rows: HoldingPosition[]) => rows.reduce((sum, p) => sum + (p.quantity || 0), 0)
  const sumMarketValue = (rows: HoldingPosition[]) => rows.reduce((sum, p) => sum + (p.market_value || 0), 0)

  const broker_quantity = sumQty(brokerPositions)
  const broker_market_value = sumMarketValue(brokerPositions)
  const paper_quantity = sumQty(paperPositions)
  const paper_market_value = sumMarketValue(paperPositions)
  const tracker_quantity = sumQty(trackerPositions)
  const tracker_market_value = ghos.total_market_value

  const hasBrokerPosition = brokerPositions.length > 0
  const hasTrackerPosition = trackerPositions.length > 0
  const owned_quantity = hasBrokerPosition ? broker_quantity : hasTrackerPosition ? tracker_quantity : 0
  const owned_market_value = hasBrokerPosition
    ? broker_market_value
    : hasTrackerPosition
      ? tracker_market_value
      : 0
  const answer_source: HoldingSummary['answer_source'] = hasBrokerPosition
    ? 'moomoo_live'
    : hasTrackerPosition
      ? 'ghostfolio_tracker'
      : 'none'

  const quantityDelta = hasBrokerPosition && hasTrackerPosition
    ? tracker_quantity - broker_quantity
    : null
  const reconciliation: HoldingSummary['reconciliation'] = quantityDelta == null
    ? {
        status: 'not_compared',
        quantity_delta: null,
        note: hasTrackerPosition
          ? 'Only Ghostfolio tracker data was found for this symbol.'
          : 'Need both moomoo live and Ghostfolio tracker positions to compare quantities.',
      }
    : Math.abs(quantityDelta) < 0.000001
      ? {
          status: 'matched',
          quantity_delta: 0,
          note: 'Ghostfolio tracker quantity matches the moomoo live broker quantity.',
        }
      : {
          status: 'mismatch',
          quantity_delta: quantityDelta,
          note: 'Ghostfolio tracker quantity differs from the moomoo live broker quantity; treat this as a reconciliation issue, not extra shares.',
        }

  const allocation_pct = ghos.net_worth_total && ghos.net_worth_total > 0 && tracker_market_value > 0
    ? (tracker_market_value / ghos.net_worth_total) * 100
    : null

  return {
    symbol,
    positions,
    owned_quantity,
    owned_market_value,
    answer_source,
    broker_quantity,
    broker_market_value,
    paper_quantity,
    paper_market_value,
    tracker_quantity,
    tracker_market_value,
    // Backward-compatible fields deliberately mirror the answerable owned
    // value instead of summing tracker + broker data. Ghostfolio is not an
    // independent broker, so adding it to moomoo double counts.
    total_quantity: owned_quantity,
    total_market_value: owned_market_value,
    net_worth_total: ghos.net_worth_total,
    net_worth_currency: ghos.base_currency,
    allocation_pct,
    allocation_source: allocation_pct == null ? null : 'ghostfolio_tracker',
    cash_paper_usd: moomoo.cash_paper_usd,
    cash_live_usd: moomoo.cash_live_usd,
    cash_paper_by_currency: moomoo.cash_paper_by_currency,
    cash_live_by_currency: moomoo.cash_live_by_currency,
    ghostfolio_status: ghos.status,
    reconciliation,
    value_units_note: 'Ghostfolio values are in its base currency (MYR here). Moomoo live/paper market values are in the broker market currency, typically USD for US symbols and HKD for HK symbols. Do not add those values without FX conversion.',
    ghostfolio_accounts: ghos.account_names,
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

// ---------------------------------------------------------------------------
// Full portfolio aggregator (cross-broker). Powers the /portfolio page so the
// user doesn't need to leave the app to check Ghostfolio.
// ---------------------------------------------------------------------------

export interface FullPortfolioAccount {
  name: string
  platform: string | null
  currency: string
  balance: number
  value_in_base: number
}

export interface FullPortfolioPosition {
  symbol: string
  name: string
  quantity: number
  market_price: number
  market_value: number
  investment: number
  allocation_pct: number
  pnl_pct: number
  asset_class: string
  sectors: string[]
  currency: string
}

export interface FullPortfolioMoomooPosition {
  symbol: string
  quantity: number
  market_value: number
  pnl_pct: number
  account_id: string
  // Settlement currency of market_value (e.g. 'USD', 'HKD'). null when unknown.
  currency: string | null
}

export interface FullPortfolio {
  net_worth_total: number | null
  net_worth_currency: string
  cash_total: number | null
  positions_value: number | null
  total_pnl_pct: number | null
  accounts: FullPortfolioAccount[]
  positions: FullPortfolioPosition[]
  moomoo_paper: FullPortfolioMoomooPosition[]
  moomoo_live: FullPortfolioMoomooPosition[]
  ghostfolio_status: GhostfolioStatus
}

interface GhostfolioFullSlice {
  status: GhostfolioStatus
  net_worth_total: number | null
  net_worth_currency: string
  cash_total: number | null
  positions_value: number | null
  total_pnl_pct: number | null
  accounts: FullPortfolioAccount[]
  positions: FullPortfolioPosition[]
}

const EMPTY_GHOSTFOLIO_SLICE: GhostfolioFullSlice = {
  status: 'not_configured',
  net_worth_total: null,
  net_worth_currency: 'MYR',
  cash_total: null,
  positions_value: null,
  total_pnl_pct: null,
  accounts: [],
  positions: [],
}

function toStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return []
  const out: string[] = []
  for (const v of x) {
    if (typeof v === 'string' && v) out.push(v)
    else if (isRecord(v) && typeof v.name === 'string' && v.name) out.push(v.name)
  }
  return out
}

async function fetchGhostfolioFullSlice(): Promise<GhostfolioFullSlice> {
  const status = await getGhostfolioStatus()
  if (status !== 'ok') {
    return { ...EMPTY_GHOSTFOLIO_SLICE, status }
  }

  // get_portfolio_details — top-line summary
  let netWorthTotal: number | null = null
  let cashTotal: number | null = null
  let positionsValue: number | null = null
  let totalPnlPct: number | null = null
  let baseCurrency = 'MYR'
  for (const name of GHOSTFOLIO_DETAILS_TOOL_CANDIDATES) {
    try {
      const details = await callGhostfolioTool(name, {})
      if (!isRecord(details)) continue
      const summary = isRecord(details.summary) ? details.summary : null
      if (!summary) continue
      netWorthTotal = toNumber(summary.totalValueInBaseCurrency)
        ?? toNumber(summary.currentValueInBaseCurrency)
        ?? (isRecord(summary.fireWealth) && isRecord(summary.fireWealth.today)
          ? toNumber(summary.fireWealth.today.valueInBaseCurrency)
          : null)
      cashTotal = toNumber(summary.cash)
      // positions_value = currentValueInBaseCurrency typically excludes cash;
      // fall back to (net_worth - cash) if not directly reported.
      positionsValue = toNumber(summary.currentValueInBaseCurrency)
      if (positionsValue == null && netWorthTotal != null && cashTotal != null) {
        positionsValue = netWorthTotal - cashTotal
      }
      // Ghostfolio key is `netPerformancePercentage` (not `Percent`); also
      // accept `WithCurrencyEffect` and the legacy spelling as fallbacks.
      const pnlRaw = toNumber(summary.netPerformancePercentage)
        ?? toNumber(summary.netPerformancePercentageWithCurrencyEffect)
        ?? toNumber(summary.netPerformancePercent)
        ?? toNumber(summary.netPerformancePercentWithCurrencyEffect)
      totalPnlPct = pnlRaw != null ? pnlRaw * 100 : null
      const cur = typeof summary.baseCurrency === 'string' ? summary.baseCurrency : null
      if (cur) baseCurrency = cur
      if (netWorthTotal != null) break
    } catch {
      // best-effort
    }
  }

  // get_accounts — per-account balances + platform
  const accounts: FullPortfolioAccount[] = []
  for (const name of GHOSTFOLIO_ACCOUNTS_TOOL_CANDIDATES) {
    try {
      const acctRes = await callGhostfolioTool(name, {})
      const acctList: unknown = isRecord(acctRes)
        ? (Array.isArray(acctRes.accounts) ? acctRes.accounts : null)
        : (Array.isArray(acctRes) ? acctRes : null)
      if (!Array.isArray(acctList)) continue
      for (const a of acctList) {
        if (!isRecord(a)) continue
        const accName = typeof a.name === 'string' ? a.name : ''
        if (!accName) continue
        const platformRec = isRecord(a.platform) ? a.platform : null
        const platform = platformRec && typeof platformRec.name === 'string' ? platformRec.name : null
        const currency = typeof a.currency === 'string' ? a.currency : baseCurrency
        const balance = toNumber(a.balance) ?? 0
        const valueInBase = toNumber(a.valueInBaseCurrency) ?? toNumber(a.value) ?? balance
        accounts.push({
          name: accName,
          platform,
          currency,
          balance,
          value_in_base: valueInBase,
        })
      }
      if (accounts.length > 0) break
    } catch {
      // best-effort
    }
  }

  // get_portfolio_holdings — every position
  let raw: unknown = null
  for (const name of GHOSTFOLIO_HOLDINGS_TOOL_CANDIDATES) {
    try {
      raw = await callGhostfolioTool(name, {})
      if (raw) break
    } catch {
      // best-effort — fall through to next candidate
    }
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

  const positions: FullPortfolioPosition[] = []
  for (const h of holdingsArr) {
    if (!isRecord(h)) continue
    const sym = String(h.symbol ?? h.code ?? h.ticker ?? '')
    if (!sym) continue
    const qty = toNumber(h.quantity) ?? toNumber(h.qty) ?? 0
    const mv = toNumber(h.valueInBaseCurrency) ?? toNumber(h.marketValue) ?? toNumber(h.value) ?? 0
    const investment = toNumber(h.investment) ?? 0
    const marketPrice = toNumber(h.marketPrice) ?? toNumber(h.currentPrice) ?? 0
    const allocRaw = toNumber(h.allocationInPercentage)
    // Ghostfolio returns 0..1 fractions for percentages. Normalize to 0..100.
    const allocPct = allocRaw != null
      ? (allocRaw <= 1 ? allocRaw * 100 : allocRaw)
      : 0
    // Ghostfolio returns a fraction (0.4753 for +47.53%, 1.5 for +150%).
    const pnlRaw = toNumber(h.netPerformancePercent)
      ?? toNumber(h.netPerformancePercentWithCurrencyEffect)
      ?? 0
    const pnlPct = pnlRaw * 100
    positions.push({
      symbol: sym,
      name: typeof h.name === 'string' ? h.name : sym,
      quantity: qty,
      market_price: marketPrice,
      market_value: mv,
      investment,
      allocation_pct: allocPct,
      pnl_pct: pnlPct,
      asset_class: typeof h.assetClass === 'string' ? h.assetClass : 'UNKNOWN',
      sectors: toStringArray(h.sectors),
      currency: typeof h.currency === 'string' ? h.currency : baseCurrency,
    })
  }

  return {
    status: 'ok',
    net_worth_total: netWorthTotal,
    net_worth_currency: baseCurrency,
    cash_total: cashTotal,
    positions_value: positionsValue,
    total_pnl_pct: totalPnlPct,
    accounts,
    positions,
  }
}

interface MoomooFullSlice {
  paper: FullPortfolioMoomooPosition[]
  live: FullPortfolioMoomooPosition[]
}

async function fetchMoomooFullSlice(): Promise<MoomooFullSlice> {
  const empty: MoomooFullSlice = { paper: [], live: [] }
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
  const out: MoomooFullSlice = { paper: [], live: [] }

  await Promise.all(
    tradingAccounts.map(async (acc) => {
      try {
        const portfolio: Portfolio = await client.getPortfolio({ acc_id: acc.acc_id, trd_env: acc.trd_env })
        const isPaper = acc.trd_env === 'SIMULATE'
        const bucket = isPaper ? out.paper : out.live
        for (const p of portfolio.positions) {
          bucket.push({
            symbol: p.code,
            quantity: p.qty,
            market_value: p.market_val ?? 0,
            pnl_pct: (p.pl_ratio ?? 0) * 100,
            account_id: acc.acc_id,
            currency: p.currency ?? portfolio.currency ?? null,
          })
        }
      } catch (err) {
        console.warn(`[holdings] moomoo getPortfolio failed for ${acc.acc_id}:`, err instanceof Error ? err.message : String(err))
      }
    }),
  )

  return out
}

/**
 * Aggregates the user's entire investment picture across Ghostfolio +
 * Moomoo. Powers the /portfolio page; the agent's `holdings_context` tool
 * still uses `getHoldingForSymbol` for per-symbol queries.
 *
 * Always resolves — partial failure (e.g. Ghostfolio offline) is reflected
 * via `ghostfolio_status` and an empty positions/accounts list.
 */
export async function getFullPortfolio(): Promise<FullPortfolio> {
  const [ghosRes, moomooRes] = await Promise.allSettled([
    fetchGhostfolioFullSlice(),
    fetchMoomooFullSlice(),
  ])

  const ghos: GhostfolioFullSlice = ghosRes.status === 'fulfilled'
    ? ghosRes.value
    : { ...EMPTY_GHOSTFOLIO_SLICE, status: 'failing' }

  const moomoo: MoomooFullSlice = moomooRes.status === 'fulfilled'
    ? moomooRes.value
    : { paper: [], live: [] }

  return {
    net_worth_total: ghos.net_worth_total,
    net_worth_currency: ghos.net_worth_currency,
    cash_total: ghos.cash_total,
    positions_value: ghos.positions_value,
    total_pnl_pct: ghos.total_pnl_pct,
    accounts: ghos.accounts,
    positions: ghos.positions,
    moomoo_paper: moomoo.paper,
    moomoo_live: moomoo.live,
    ghostfolio_status: ghos.status,
  }
}
