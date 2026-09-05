import { createError, defineEventHandler, getQuery } from 'h3'
import { getDailyBars, getFinancialMetrics, getFxRate, getHistorical } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'

/**
 * Inputs for the deterministic valuation. The DCF is computed in the
 * currency the statements are reported in, so when the quote trades in a
 * different currency (Tencent: HKD quote, CNY statements) the price series is
 * converted at the current FX rate before it leaves here. The api has no FX
 * source of its own; `price_conversion` tells it what was done.
 */
export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const [metrics, history, bars] = await Promise.all([
    getFinancialMetrics(symbol),
    getHistorical(symbol, 6),
    getDailyBars(symbol, 252),
  ])

  const priceCcy = metrics.currency
  const finCcy = metrics.financial_currency
  let dailyBars = bars
  let price_conversion: { from: string; to: string; rate: number } | null = null
  let price_conversion_error: string | null = null
  if (priceCcy && finCcy && priceCcy !== finCcy) {
    const rate = await getFxRate(priceCcy, finCcy)
    if (rate != null && rate > 0) {
      dailyBars = bars.map(b => ({ ...b, open: b.open * rate, high: b.high * rate, low: b.low * rate, close: b.close * rate }))
      price_conversion = { from: priceCcy, to: finCcy, rate }
    } else {
      price_conversion_error = `quote is in ${priceCcy} but statements are in ${finCcy} and no FX rate was available`
    }
  }
  return { symbol, metrics, history, dailyBars, price_conversion, price_conversion_error }
})
