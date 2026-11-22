import type { FullPortfolio } from './holdings'
import { normalizeAssetClass, type PlanningBucketKey, type PlanningSummary } from './planning'
import type { Instrument, RebalanceInputs, SkippedSymbol } from './planning-assistant'
import { getFxRate, getYahooQuote, resolveSymbol, toYahooSymbol } from './yahoo'

export interface RebalanceCandidate {
  symbol: string
  /** Required unless the live broker account already holds the symbol. */
  bucket?: PlanningBucketKey
}

/**
 * What a rebalance plan may trade: the unlocked holdings the live broker
 * accounts hold, and the candidates the broker can trade. Holdings that are
 * only tracked in Ghostfolio are left out, since no order can reach them. The
 * share count is the broker's: the tracker's can differ by a fraction.
 */
export async function loadRebalanceInputs(
  portfolio: FullPortfolio,
  summary: PlanningSummary,
  candidates: RebalanceCandidate[],
): Promise<RebalanceInputs> {
  const base = summary.base_currency
  const locked = new Set(summary.locked.holdings.map(h => h.symbol.toUpperCase()))
  const brokerShares = new Map<string, number>()
  for (const m of portfolio.moomoo_live) {
    const key = toYahooSymbol(m.symbol).toUpperCase()
    brokerShares.set(key, (brokerShares.get(key) ?? 0) + m.quantity)
  }
  const skipped: SkippedSymbol[] = []

  const rates = new Map<string, Promise<number | null>>()
  const rateOf = (currency: string) => {
    if (!rates.has(currency)) rates.set(currency, getFxRate(currency, base))
    return rates.get(currency)!
  }
  const priced = async (i: Omit<Instrument, 'fx_rate'>): Promise<Instrument | null> => {
    const fx_rate = i.price > 0 ? await rateOf(i.currency) : null
    if (fx_rate == null) {
      skipped.push({ symbol: i.symbol, reason: i.price > 0 ? 'no_fx_rate' : 'no_price' })
      return null
    }
    return { ...i, fx_rate }
  }

  const held = new Map<string, Omit<Instrument, 'fx_rate'>>()
  for (const p of portfolio.positions) {
    const bucket = normalizeAssetClass(p.asset_class)
    const key = p.symbol.toUpperCase()
    const shares = brokerShares.get(key)
    if (bucket === 'cash' || p.market_value <= 0 || locked.has(key) || !shares) continue
    held.set(key, {
      symbol: p.symbol, name: p.name || p.symbol, bucket, price: p.market_price, currency: p.currency,
      held_shares: shares, held_value: p.market_value, candidate: false,
    })
  }

  for (const c of candidates) {
    const symbol = c.symbol.trim()
    const key = toYahooSymbol(symbol.toUpperCase()).toUpperCase()
    if (locked.has(symbol.toUpperCase()) || locked.has(key)) {
      skipped.push({ symbol, reason: 'locked' })
      continue
    }
    const own = held.get(key)
    if (own) {
      held.set(key, { ...own, bucket: c.bucket ?? own.bucket, candidate: true })
      continue
    }
    if (!c.bucket) {
      skipped.push({ symbol, reason: 'bucket_required' })
      continue
    }
    const found = await resolveSymbol(symbol)
    if (found.status !== 'resolved') {
      skipped.push({ symbol, reason: 'not_found' })
      continue
    }
    if (!found.moomoo) {
      skipped.push({ symbol, reason: 'not_tradable' })
      continue
    }
    const quote = await getYahooQuote(found.yahoo)
    if (!quote?.currency) {
      skipped.push({ symbol, reason: 'no_price' })
      continue
    }
    held.set(found.yahoo.toUpperCase(), {
      symbol: found.yahoo, name: quote.name ?? found.name, bucket: c.bucket, price: quote.lastPrice, currency: quote.currency,
      held_shares: 0, held_value: 0, candidate: true,
    })
  }

  const instruments = (await Promise.all([...held.values()].map(priced))).filter((i): i is Instrument => i !== null)
  return {
    instruments,
    skipped,
    broker_cash: portfolio.moomoo_live_cash,
    broker_status: portfolio.moomoo_status,
    fetched_at: portfolio.fetched_at,
  }
}
