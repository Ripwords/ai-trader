import { getApiClient } from '../llm/http'
import type { Portfolio } from '../llm/http'

/**
 * The INVESTMENTS layer: what the user actually owns on Moomoo live.
 *
 * This is deliberately separate from the NET WORTH layer (Ghostfolio, see
 * holdings.ts / portfolio-history.ts). Ghostfolio tracks total net worth
 * including cash and non-investment accounts, and it also mirrors the Moomoo
 * account — so the two overlap by design and must never be summed, and a
 * net-worth delta must never be presented as investment performance.
 *
 * Every unqualified "how is my portfolio doing" question resolves here.
 */

/**
 * Currency the blended totals are expressed in. Shares MOOMOO_REPORT_CURRENCY
 * with the Python side so both layers report the same unit; the default here
 * matches the adapter's default rather than moomoo's HKD.
 */
const REPORTING_CURRENCY = (process.env.MOOMOO_REPORT_CURRENCY || 'MYR').toUpperCase()

export interface InvestmentPosition {
  symbol: string
  qty: number
  /** Native settlement currency (USD / HKD / …). null when the broker omits it. */
  currency: string | null
  last_price: number
  /** Previous close from the quote snapshot. null when the quote was unavailable. */
  prev_close: number | null
  /** Market value in the position's native currency. */
  market_value: number
  day_change_value: number | null
  day_change_pct: number | null
  cost_price: number
  cost_basis: number
  unrealized_pl: number
  unrealized_pl_pct: number
  /** Share of the FX-normalised total. null when FX was unavailable. */
  weight_pct: number | null
}

export interface CurrencyTotals {
  currency: string
  market_value: number
  day_change_value: number | null
  day_change_pct: number | null
  unrealized_pl: number
}

export interface InvestmentPortfolio {
  source: 'moomoo_live'
  status: 'ok' | 'no_positions' | 'unavailable'
  as_of: string
  /** acc_ids that actually contributed data. */
  accounts: string[]
  reporting_currency: string
  positions: InvestmentPosition[]
  by_currency: CurrencyTotals[]
  total_market_value_reporting: number | null
  total_day_change_reporting: number | null
  /** FX-weighted blend — comparable to an index move. */
  total_day_change_pct: number | null
  total_unrealized_pl_reporting: number | null
  cash_by_currency: Record<string, number>
  caveats: string[]
}

const UNKNOWN_CURRENCY = 'UNKNOWN'

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function empty(status: InvestmentPortfolio['status'], caveats: string[]): InvestmentPortfolio {
  return {
    source: 'moomoo_live',
    status,
    as_of: new Date().toISOString(),
    accounts: [],
    reporting_currency: REPORTING_CURRENCY,
    positions: [],
    by_currency: [],
    total_market_value_reporting: null,
    total_day_change_reporting: null,
    total_day_change_pct: null,
    total_unrealized_pl_reporting: null,
    cash_by_currency: {},
    caveats,
  }
}

interface MergedPosition {
  symbol: string
  currency: string | null
  qty: number
  costTotal: number
  marketValue: number
  unrealizedPl: number
  lastPrice: number
}

/**
 * Merge the same symbol held across several accounts into one line. Quantity
 * is summed and cost is quantity-weighted, so the reported average cost is the
 * blended basis rather than whichever account happened to be read last.
 */
function mergePositions(portfolios: Portfolio[]): MergedPosition[] {
  const bySymbol = new Map<string, MergedPosition>()
  for (const p of portfolios) {
    for (const raw of p.positions ?? []) {
      const symbol = raw.code
      const existing = bySymbol.get(symbol)
      const qty = raw.qty || 0
      if (existing) {
        existing.qty += qty
        existing.costTotal += (raw.cost_price || 0) * qty
        existing.marketValue += raw.market_val || 0
        existing.unrealizedPl += raw.pl_val || 0
        existing.lastPrice = raw.current_price || existing.lastPrice
        existing.currency = existing.currency ?? raw.currency ?? null
      } else {
        bySymbol.set(symbol, {
          symbol,
          currency: raw.currency ?? null,
          qty,
          costTotal: (raw.cost_price || 0) * qty,
          marketValue: raw.market_val || 0,
          unrealizedPl: raw.pl_val || 0,
          lastPrice: raw.current_price || 0,
        })
      }
    }
  }
  return [...bySymbol.values()]
}

function mergeCash(portfolios: Portfolio[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of portfolios) {
    for (const [ccy, amount] of Object.entries(p.cash_by_currency ?? {})) {
      if (!amount) continue
      out[ccy] = (out[ccy] ?? 0) + amount
    }
  }
  return out
}

export async function getInvestmentPortfolio(): Promise<InvestmentPortfolio> {
  const caveats: string[] = []
  const client = getApiClient()

  let accounts
  try {
    accounts = await client.listAccounts()
  } catch (err) {
    return empty('unavailable', [
      `Could not reach the moomoo live account: ${errMessage(err)}.`,
    ])
  }

  // The investments layer is live money only. Paper is a different thing and
  // IPO accounts refuse portfolio queries.
  const live = (accounts ?? []).filter(a => a.trd_env === 'REAL' && a.acc_role !== 'IPO')
  if (live.length === 0) {
    return empty('unavailable', [
      'No usable moomoo live (REAL, non-IPO) account is available, so the investments layer cannot be read. Do not substitute net worth for this.',
    ])
  }

  const settled = await Promise.allSettled(
    live.map(a => client.getPortfolio({ acc_id: a.acc_id, trd_env: 'REAL' })),
  )
  const portfolios: Portfolio[] = []
  const usedAccounts: string[] = []
  settled.forEach((res, i) => {
    const accId = live[i]!.acc_id
    if (res.status === 'fulfilled') {
      portfolios.push(res.value)
      usedAccounts.push(accId)
    } else {
      caveats.push(`Account ${accId} could not be read: ${errMessage(res.reason)}.`)
    }
  })

  if (portfolios.length === 0) {
    return empty('unavailable', [
      ...caveats,
      'Every moomoo live account failed to read, so the investments layer is unavailable. Do not substitute net worth for this.',
    ])
  }

  const cash_by_currency = mergeCash(portfolios)
  const merged = mergePositions(portfolios)

  if (merged.length === 0) {
    return {
      ...empty('no_positions', caveats),
      accounts: usedAccounts,
      cash_by_currency,
    }
  }

  // Previous close is the only thing the quote layer is needed for; market
  // value comes from the broker so the two can't drift apart.
  const prevCloseBySymbol = new Map<string, number | null>()
  const snaps = await Promise.allSettled(
    merged.map(m => client.getSnapshot({ code: m.symbol })),
  )
  snaps.forEach((res, i) => {
    const symbol = merged[i]!.symbol
    if (res.status === 'fulfilled' && Number.isFinite(res.value?.prevClosePrice)) {
      prevCloseBySymbol.set(symbol, res.value.prevClosePrice)
    } else {
      prevCloseBySymbol.set(symbol, null)
      caveats.push(
        `No previous close for ${symbol}, so its day change is unknown${
          res.status === 'rejected' ? `: ${errMessage(res.reason)}` : ''
        }.`,
      )
    }
  })

  const positions: InvestmentPosition[] = merged.map((m) => {
    const prevClose = prevCloseBySymbol.get(m.symbol) ?? null
    const prevValue = prevClose != null && prevClose > 0 ? prevClose * m.qty : null
    const dayChangeValue = prevValue != null ? m.marketValue - prevValue : null
    const costPrice = m.qty > 0 ? m.costTotal / m.qty : 0
    return {
      symbol: m.symbol,
      qty: m.qty,
      currency: m.currency,
      last_price: m.lastPrice,
      prev_close: prevClose != null && prevClose > 0 ? prevClose : null,
      market_value: m.marketValue,
      day_change_value: dayChangeValue,
      day_change_pct: dayChangeValue != null && prevValue ? (dayChangeValue / prevValue) * 100 : null,
      cost_price: costPrice,
      cost_basis: m.costTotal,
      unrealized_pl: m.unrealizedPl,
      unrealized_pl_pct: m.costTotal ? (m.unrealizedPl / m.costTotal) * 100 : 0,
      weight_pct: null, // filled in below, once FX is known
    }
  })

  // --- Per-currency buckets. Native amounts are only ever added to amounts in
  // the same currency; the cross-currency blend happens once, below, via FX.
  const buckets = new Map<string, { mv: number; day: number; dayKnown: boolean; prev: number; pl: number }>()
  for (const p of positions) {
    const key = p.currency ?? UNKNOWN_CURRENCY
    const b = buckets.get(key) ?? { mv: 0, day: 0, dayKnown: true, prev: 0, pl: 0 }
    b.mv += p.market_value
    b.pl += p.unrealized_pl
    if (p.day_change_value == null) {
      b.dayKnown = false
    } else {
      b.day += p.day_change_value
      b.prev += p.market_value - p.day_change_value
    }
    buckets.set(key, b)
  }

  const by_currency: CurrencyTotals[] = [...buckets.entries()].map(([currency, b]) => ({
    currency,
    market_value: b.mv,
    day_change_value: b.dayKnown ? b.day : null,
    day_change_pct: b.dayKnown && b.prev > 0 ? (b.day / b.prev) * 100 : null,
    unrealized_pl: b.pl,
  }))

  // --- FX blend into the reporting currency.
  const { getFxRate } = await import('./yahoo')
  const rates = new Map<string, number | null>()
  await Promise.all(
    [...buckets.keys()].map(async (ccy) => {
      if (ccy === UNKNOWN_CURRENCY) {
        rates.set(ccy, null)
        return
      }
      try {
        rates.set(ccy, await getFxRate(ccy, REPORTING_CURRENCY))
      } catch {
        rates.set(ccy, null)
      }
    }),
  )

  let totalMv = 0
  let totalDay = 0
  let totalPrev = 0
  let totalPl = 0
  let fxComplete = true
  let dayComplete = true
  for (const [ccy, b] of buckets.entries()) {
    const rate = rates.get(ccy) ?? null
    if (rate == null) {
      fxComplete = false
      caveats.push(
        ccy === UNKNOWN_CURRENCY
          ? 'Some positions have no settlement currency, so they cannot be converted into the reporting currency.'
          : `No ${ccy}→${REPORTING_CURRENCY} FX rate available, so ${ccy} holdings are excluded from the combined total.`,
      )
      continue
    }
    totalMv += b.mv * rate
    totalPl += b.pl * rate
    if (b.dayKnown) {
      totalDay += b.day * rate
      totalPrev += (b.mv - b.day) * rate
    } else {
      dayComplete = false
    }
  }

  if (fxComplete) {
    const denominator = totalMv || 1
    for (const p of positions) {
      const rate = rates.get(p.currency ?? UNKNOWN_CURRENCY) ?? null
      p.weight_pct = rate == null ? null : ((p.market_value * rate) / denominator) * 100
    }
  }

  const blendedDayKnown = fxComplete && dayComplete && totalPrev > 0

  return {
    source: 'moomoo_live',
    status: 'ok',
    as_of: new Date().toISOString(),
    accounts: usedAccounts,
    reporting_currency: REPORTING_CURRENCY,
    positions,
    by_currency,
    total_market_value_reporting: fxComplete ? totalMv : null,
    total_day_change_reporting: blendedDayKnown ? totalDay : null,
    total_day_change_pct: blendedDayKnown ? (totalDay / totalPrev) * 100 : null,
    total_unrealized_pl_reporting: fxComplete ? totalPl : null,
    cash_by_currency,
    caveats,
  }
}
