import { createError, defineEventHandler, getQuery } from 'h3'
import { getFundamentalsBundle } from '../../../lib/yahoo'
import { getCashflowSeries, type CashflowSeries } from '../../../lib/cashflow-series'
import { requireInternalBearer } from '../_guard'
import { cacheGet, cacheSet } from '../_cache'

interface CashflowResponse {
  symbol: string
  cashflow: unknown
  /** Quarterly / TTM / annual OCF − capex, each row labelled with its period. */
  series: CashflowSeries | null
  /** Yahoo's financialData.freeCashflow, which is NOT OCF − capex. */
  yahoo_levered_fcf: { value: number | null; definition: string }
}

const LEVERED_FCF_DEFINITION
  = 'Yahoo Finance financialData.freeCashflow: a levered free cash flow estimate (after interest, its own capex and working-capital treatment), not OCF − capex and not the company-reported figure'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { symbol } = getQuery(event)
  if (typeof symbol !== 'string' || !symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const cacheKey = `yahoo:cashflow:${symbol}`
  const cached = cacheGet<CashflowResponse>(cacheKey, SIX_HOURS_MS)
  if (cached) return cached

  let seriesFailed = false
  const [bundle, series] = await Promise.all([
    getFundamentalsBundle(symbol),
    getCashflowSeries(symbol).catch((err: unknown) => {
      console.error('[internal/yahoo/cashflow] series failed', symbol, err)
      seriesFailed = true
      return null
    }),
  ])
  const out: CashflowResponse = {
    symbol: bundle.symbol,
    cashflow: bundle.cashflow ?? null,
    series,
    yahoo_levered_fcf: { value: bundle.metrics?.free_cash_flow ?? null, definition: LEVERED_FCF_DEFINITION },
  }
  // A failed lookup is usually transient (getHistorical returns [] when Yahoo
  // fails); caching it would hide the data for six hours.
  if (!seriesFailed && bundle.history.length > 0) cacheSet(cacheKey, out)
  return out
})
