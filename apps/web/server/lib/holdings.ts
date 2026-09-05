import { callGhostfolioTool, getGhostfolioStatus, type GhostfolioStatus } from '../llm/mcp'
import { getApiClient } from '../llm/http'
import type { Account, Portfolio } from '../llm/http'
import { toYahooSymbol } from './yahoo'

/**
 * The two portfolio sources, read once each and projected two ways:
 *
 * - `getFullPortfolio()` powers the /portfolio page and the net-worth
 *   snapshot: Ghostfolio's aggregate plus the raw moomoo paper/live slices.
 * - `getHoldingForSymbol()` powers the `holdings_context` chat tool: the
 *   same two reads narrowed to one symbol, with the broker/tracker
 *   reconciliation the prompt relies on.
 *
 * Ghostfolio mirrors the moomoo account, so nothing here ever adds a
 * Ghostfolio figure to a moomoo figure.
 */

export interface HoldingPosition {
  source: 'ghostfolio' | 'moomoo_live' | 'moomoo_paper'
  symbol: string
  quantity: number
  avg_cost: number | null
  current_price: number | null
  market_value: number | null
  /** Percent (12.5 for +12.5%) for every source. */
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
  /** valueInBaseCurrency: denominated in the Ghostfolio base currency. */
  market_value: number
  investment: number
  allocation_pct: number
  /** Percent (47.53 for +47.53%). */
  pnl_pct: number
  asset_class: string
  sectors: string[]
  /** The asset's own trading currency (not the currency of market_value). */
  currency: string
}

export interface FullPortfolioMoomooPosition {
  symbol: string
  quantity: number
  market_value: number
  /** Percent (12.5 for +12.5%). */
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

// ---------------------------------------------------------------------------
// Ghostfolio
// ---------------------------------------------------------------------------

interface GhostfolioSlice {
  status: GhostfolioStatus
  net_worth_total: number | null
  net_worth_currency: string
  cash_total: number | null
  positions_value: number | null
  total_pnl_pct: number | null
  accounts: FullPortfolioAccount[]
  positions: FullPortfolioPosition[]
}

const EMPTY_GHOSTFOLIO_SLICE: GhostfolioSlice = {
  status: 'not_configured',
  net_worth_total: null,
  net_worth_currency: 'MYR',
  cash_total: null,
  positions_value: null,
  total_pnl_pct: null,
  accounts: [],
  positions: [],
}

// Verified against the user's mhajder/ghostfolio-mcp server. Older Ghostfolio
// MCP forks may use camelCase aliases — we keep those as fallbacks but try
// the canonical snake_case names first.
const GHOSTFOLIO_HOLDINGS_TOOL_CANDIDATES = ['get_portfolio_holdings', 'getHoldings', 'holdings']
const GHOSTFOLIO_DETAILS_TOOL_CANDIDATES = ['get_portfolio_details', 'getPortfolioDetails']
const GHOSTFOLIO_ACCOUNTS_TOOL_CANDIDATES = ['get_accounts', 'getAccounts']

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

function toStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return []
  const out: string[] = []
  for (const v of x) {
    if (typeof v === 'string' && v) out.push(v)
    else if (isRecord(v) && typeof v.name === 'string' && v.name) out.push(v.name)
  }
  return out
}

/** First candidate tool that answers, or null when every probe failed. */
async function probeGhostfolio(candidates: string[]): Promise<unknown> {
  let lastErr: unknown = null
  for (const name of candidates) {
    try {
      const raw = await callGhostfolioTool(name, {})
      if (raw != null) return raw
    } catch (err) {
      lastErr = err
    }
  }
  if (lastErr) console.warn('[holdings] ghostfolio probe failed:', lastErr instanceof Error ? lastErr.message : String(lastErr))
  return null
}

function listFrom(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw
  if (isRecord(raw)) {
    for (const k of keys) {
      if (Array.isArray(raw[k])) return raw[k] as unknown[]
    }
  }
  return []
}

async function fetchGhostfolioSlice(): Promise<GhostfolioSlice> {
  const status = await getGhostfolioStatus()
  if (status !== 'ok') return { ...EMPTY_GHOSTFOLIO_SLICE, status }

  const [details, acctRes, holdingsRaw] = await Promise.all([
    probeGhostfolio(GHOSTFOLIO_DETAILS_TOOL_CANDIDATES),
    probeGhostfolio(GHOSTFOLIO_ACCOUNTS_TOOL_CANDIDATES),
    probeGhostfolio(GHOSTFOLIO_HOLDINGS_TOOL_CANDIDATES),
  ])
  if (details == null && holdingsRaw == null) {
    return { ...EMPTY_GHOSTFOLIO_SLICE, status: 'failing' }
  }

  // Net worth lives in get_portfolio_details.summary.totalValueInBaseCurrency.
  // Fall back to currentValueInBaseCurrency / fireWealth.today if missing.
  let netWorthTotal: number | null = null
  let cashTotal: number | null = null
  let positionsValue: number | null = null
  let totalPnlPct: number | null = null
  let baseCurrency = EMPTY_GHOSTFOLIO_SLICE.net_worth_currency
  const summary = isRecord(details) && isRecord(details.summary) ? details.summary : null
  if (summary) {
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
    if (typeof summary.baseCurrency === 'string' && summary.baseCurrency) baseCurrency = summary.baseCurrency
  }

  const accounts: FullPortfolioAccount[] = []
  for (const a of listFrom(acctRes, ['accounts'])) {
    if (!isRecord(a) || typeof a.name !== 'string' || !a.name) continue
    const platformRec = isRecord(a.platform) ? a.platform : null
    const balance = toNumber(a.balance) ?? 0
    accounts.push({
      name: a.name,
      platform: platformRec && typeof platformRec.name === 'string' ? platformRec.name : null,
      currency: typeof a.currency === 'string' ? a.currency : baseCurrency,
      balance,
      value_in_base: toNumber(a.valueInBaseCurrency) ?? toNumber(a.value) ?? balance,
    })
  }

  const positions: FullPortfolioPosition[] = []
  for (const h of listFrom(holdingsRaw, ['holdings', 'positions', 'items', 'data'])) {
    if (!isRecord(h)) continue
    // Ghostfolio (via mhajder/ghostfolio-mcp) nests the instrument fields
    // under assetProfile: { symbol, name, currency, assetClass, sectors }.
    // The numbers (quantity, valueInBaseCurrency, investment, marketPrice,
    // netPerformancePercent, allocationInPercentage) stay top-level. Older
    // forks flatten everything, so both layouts are read.
    const profile = isRecord(h.assetProfile) ? h.assetProfile : {}
    const str = (key: string): string | null => {
      const v = h[key] ?? profile[key]
      return typeof v === 'string' && v ? v : null
    }
    const sym = str('symbol') ?? str('code') ?? str('ticker')
    if (!sym) continue
    const allocRaw = toNumber(h.allocationInPercentage)
    // Ghostfolio returns fractions (0.4753 for +47.53%, 1.5 for +150%).
    const pnlRaw = toNumber(h.netPerformancePercent) ?? toNumber(h.netPerformancePercentWithCurrencyEffect) ?? 0
    positions.push({
      symbol: sym,
      name: str('name') ?? sym,
      quantity: toNumber(h.quantity) ?? toNumber(h.qty) ?? 0,
      market_price: toNumber(h.marketPrice) ?? toNumber(h.currentPrice) ?? 0,
      market_value: toNumber(h.valueInBaseCurrency) ?? toNumber(h.marketValue) ?? toNumber(h.value) ?? 0,
      investment: toNumber(h.investment) ?? 0,
      allocation_pct: allocRaw != null ? (allocRaw <= 1 ? allocRaw * 100 : allocRaw) : 0,
      pnl_pct: pnlRaw * 100,
      asset_class: str('assetClass') ?? 'UNKNOWN',
      sectors: toStringArray(h.sectors ?? profile.sectors),
      currency: str('currency') ?? baseCurrency,
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

// ---------------------------------------------------------------------------
// moomoo
// ---------------------------------------------------------------------------

interface MoomooAccountSlice {
  acc_id: string
  isPaper: boolean
  portfolio: Portfolio
}

/** One getPortfolio per non-IPO account. Unreadable accounts are skipped with a warning. */
async function fetchMoomooAccounts(): Promise<MoomooAccountSlice[]> {
  let client: ReturnType<typeof getApiClient>
  try {
    client = getApiClient()
  } catch {
    return []
  }
  let accounts: Account[]
  try {
    accounts = await client.listAccounts()
  } catch (err) {
    console.warn('[holdings] moomoo listAccounts failed:', err instanceof Error ? err.message : String(err))
    return []
  }
  const slices = await Promise.all(
    accounts.filter(a => a.acc_role !== 'IPO').map(async (acc): Promise<MoomooAccountSlice | null> => {
      try {
        const portfolio = await client.getPortfolio({ acc_id: acc.acc_id, trd_env: acc.trd_env })
        return { acc_id: acc.acc_id, isPaper: acc.trd_env === 'SIMULATE', portfolio }
      } catch (err) {
        console.warn(`[holdings] moomoo getPortfolio failed for ${acc.acc_id}:`, err instanceof Error ? err.message : String(err))
        return null
      }
    }),
  )
  return slices.filter((s): s is MoomooAccountSlice => s !== null)
}

/**
 * Strip the moomoo market prefix (`US.`, `HK.`, etc.) for matching against
 * Ghostfolio symbols, which are typically bare tickers (`NVDA`, not `US.NVDA`).
 */
function stripMarketPrefix(code: string): string {
  const dot = code.indexOf('.')
  return dot >= 0 ? code.slice(dot + 1) : code
}

/**
 * Native per-currency cash the account actually holds. moomoo's scalar
 * `cash` + `currency` is the reporting-currency conversion of all cash, so
 * reading it here would invent a phantom balance in a currency the user
 * never held. Fall back to the scalar only when the native breakdown is
 * missing.
 */
function nativeCash(portfolio: Portfolio): Record<string, number> {
  const native = portfolio.cash_by_currency
  if (native && Object.keys(native).length > 0) return native
  return { [portfolio.currency ?? 'UNKNOWN']: portfolio.cash || 0 }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Aggregates the user's entire investment picture across Ghostfolio +
 * Moomoo. Powers the /portfolio page and the net-worth snapshot. Always
 * resolves — partial failure (e.g. Ghostfolio offline) is reflected via
 * `ghostfolio_status` and an empty positions/accounts list.
 */
export async function getFullPortfolio(): Promise<FullPortfolio> {
  const [ghos, moomoo] = await Promise.all([
    fetchGhostfolioSlice().catch((): GhostfolioSlice => ({ ...EMPTY_GHOSTFOLIO_SLICE, status: 'failing' })),
    fetchMoomooAccounts(),
  ])
  const project = (slices: MoomooAccountSlice[]): FullPortfolioMoomooPosition[] =>
    slices.flatMap(s => s.portfolio.positions.map(p => ({
      symbol: p.code,
      quantity: p.qty,
      market_value: p.market_val ?? 0,
      pnl_pct: (p.pl_ratio ?? 0) * 100,
      account_id: s.acc_id,
      currency: p.currency ?? s.portfolio.currency ?? null,
    })))
  return {
    net_worth_total: ghos.net_worth_total,
    net_worth_currency: ghos.net_worth_currency,
    cash_total: ghos.cash_total,
    positions_value: ghos.positions_value,
    total_pnl_pct: ghos.total_pnl_pct,
    accounts: ghos.accounts,
    positions: ghos.positions,
    moomoo_paper: project(moomoo.filter(s => s.isPaper)),
    moomoo_live: project(moomoo.filter(s => !s.isPaper)),
    ghostfolio_status: ghos.status,
  }
}

export async function getHoldingForSymbol(symbol: string): Promise<HoldingSummary> {
  const [ghos, moomoo] = await Promise.all([
    fetchGhostfolioSlice().catch((): GhostfolioSlice => ({ ...EMPTY_GHOSTFOLIO_SLICE, status: 'failing' })),
    fetchMoomooAccounts(),
  ])

  // Ghostfolio uses Yahoo-style symbols (NVDA, 0700.HK, 600519.SS, 0828EA.KL).
  const targetYf = toYahooSymbol(symbol)
  const trackerPositions: HoldingPosition[] = ghos.positions
    .filter(p => p.symbol === targetYf)
    .map(p => ({
      source: 'ghostfolio',
      symbol: p.symbol,
      quantity: p.quantity,
      // Weighted-average cost basis across all accounts holding this symbol.
      avg_cost: p.quantity > 0 ? p.investment / p.quantity : null,
      current_price: p.market_price || null,
      market_value: p.market_value,
      unrealized_pnl_pct: p.pnl_pct,
      account_label: 'Ghostfolio (aggregate)',
      // market_value is valueInBaseCurrency, so its unit is the Ghostfolio
      // base currency, not the asset's own trading currency.
      currency: ghos.net_worth_currency,
    }))

  const bare = stripMarketPrefix(symbol)
  const brokerPositions: HoldingPosition[] = []
  const paperPositions: HoldingPosition[] = []
  const cash_paper_by_currency: Record<string, number> = {}
  const cash_live_by_currency: Record<string, number> = {}
  let cash_paper_usd = 0
  let cash_live_usd = 0
  for (const s of moomoo) {
    const bucket = s.isPaper ? cash_paper_by_currency : cash_live_by_currency
    for (const [ccy, amt] of Object.entries(nativeCash(s.portfolio))) {
      bucket[ccy] = (bucket[ccy] ?? 0) + (amt || 0)
    }
    if (s.isPaper) cash_paper_usd += s.portfolio.cash || 0
    else cash_live_usd += s.portfolio.cash || 0
    for (const p of s.portfolio.positions) {
      if (p.code !== symbol && stripMarketPrefix(p.code) !== bare) continue
      ;(s.isPaper ? paperPositions : brokerPositions).push({
        source: s.isPaper ? 'moomoo_paper' : 'moomoo_live',
        symbol: p.code,
        quantity: p.qty,
        avg_cost: p.cost_price,
        current_price: p.current_price,
        market_value: p.market_val,
        // moomoo reports pl_ratio as a fraction (0.125).
        unrealized_pnl_pct: p.pl_ratio * 100,
        account_label: s.isPaper ? 'Moomoo Paper' : 'Moomoo Live',
        currency: p.currency ?? s.portfolio.currency ?? null,
      })
    }
  }

  const sumQty = (rows: HoldingPosition[]) => rows.reduce((sum, p) => sum + (p.quantity || 0), 0)
  const sumMarketValue = (rows: HoldingPosition[]) => rows.reduce((sum, p) => sum + (p.market_value || 0), 0)

  const broker_quantity = sumQty(brokerPositions)
  const broker_market_value = sumMarketValue(brokerPositions)
  const paper_quantity = sumQty(paperPositions)
  const paper_market_value = sumMarketValue(paperPositions)
  const tracker_quantity = sumQty(trackerPositions)
  const tracker_market_value = sumMarketValue(trackerPositions)

  const hasBrokerPosition = brokerPositions.length > 0
  const hasTrackerPosition = trackerPositions.length > 0
  const owned_quantity = hasBrokerPosition ? broker_quantity : hasTrackerPosition ? tracker_quantity : 0
  const owned_market_value = hasBrokerPosition ? broker_market_value : hasTrackerPosition ? tracker_market_value : 0
  const answer_source: HoldingSummary['answer_source'] = hasBrokerPosition
    ? 'moomoo_live'
    : hasTrackerPosition ? 'ghostfolio_tracker' : 'none'

  const quantityDelta = hasBrokerPosition && hasTrackerPosition ? tracker_quantity - broker_quantity : null
  // Ghostfolio books dividend reinvestment as fractional shares moomoo does
  // not report (10.0129 vs 10), so a sliver of a share is agreement, not a
  // reconciliation problem.
  const matchTolerance = Math.max(0.01, broker_quantity * 0.01)
  const reconciliation: HoldingSummary['reconciliation'] = quantityDelta == null
    ? {
        status: 'not_compared',
        quantity_delta: null,
        note: hasTrackerPosition
          ? 'Only Ghostfolio tracker data was found for this symbol.'
          : 'Need both moomoo live and Ghostfolio tracker positions to compare quantities.',
      }
    : Math.abs(quantityDelta) <= matchTolerance
      ? { status: 'matched', quantity_delta: quantityDelta, note: 'Ghostfolio tracker quantity matches the moomoo live broker quantity (fractional dividend reinvestment aside).' }
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
    positions: [...trackerPositions, ...brokerPositions, ...paperPositions],
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
    net_worth_currency: ghos.status === 'ok' ? ghos.net_worth_currency : null,
    allocation_pct,
    allocation_source: allocation_pct == null ? null : 'ghostfolio_tracker',
    cash_paper_usd,
    cash_live_usd,
    cash_paper_by_currency,
    cash_live_by_currency,
    ghostfolio_status: ghos.status,
    reconciliation,
    value_units_note: 'Ghostfolio values are in its base currency (MYR here). Moomoo live/paper market values are in the broker market currency, typically USD for US symbols and HKD for HK symbols. Do not add those values without FX conversion.',
    ghostfolio_accounts: ghos.accounts.map(a => a.name),
  }
}
