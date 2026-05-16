// Bundle assembler + deterministic 35/35/30 blend for the deep risk-score
// report. The route fetches all upstream data here, hands the bundle to the
// LLM module, and blends the final risk_score. There is no row cache —
// nuxt's `defineCachedFunction` already memoizes the slow moomoo legs;
// adding a per-day DB row gave little extra and the persona-era table is
// being dropped.

import { getApiClient } from '../llm/http'
import type { KLineResponse, Snapshot } from '../llm/http'
import { buildChartSummary, generateRiskReport } from '../llm/risk-report'
import {
  getCompanyNews,
  getEarningsInfo,
  getFinancialMetrics,
  getQuarterlyHistory,
} from './yahoo'
import type { PriceBar, QuarterlyRow, RiskReport, RiskReportEvent } from '../../types/research'

// moomoo fetches are cached so a `?refresh=1` regenerate (or two near-
// simultaneous opens of the same symbol) doesn't re-hit OpenD. Snapshot
// has a short TTL since price moves intraday; daily k-line is stable for
// the trading day.
const fetchSnapshotCached = defineCachedFunction(
  async (symbol: string) => {
    return getApiClient().getSnapshot({ code: symbol })
  },
  {
    name: 'risk-report',
    group: 'snapshot',
    maxAge: 60,
    swr: true,
    getKey: (symbol: string) => symbol,
  },
) as (symbol: string) => Promise<Snapshot>

const fetchKlineCached = defineCachedFunction(
  async (symbol: string) => {
    return getApiClient().getKline({ code: symbol, ktype: '1d', num: 252 })
  },
  {
    name: 'risk-report',
    group: 'kline-1d',
    maxAge: 60 * 60 * 6,
    swr: true,
    getKey: (symbol: string) => symbol,
  },
) as (symbol: string) => Promise<KLineResponse>

// 35% valuation · 35% health · 30% growth — fixed weights so the score
// breakdown bars on the page always equal the displayed total. The LLM
// never sees the weights and never returns the final risk_score.
const WEIGHT_VALUATION = 0.35
const WEIGHT_HEALTH = 0.35
const WEIGHT_GROWTH = 0.30

export function blendRiskScore(valuation: number, health: number, growth: number): number {
  const blended = WEIGHT_VALUATION * valuation + WEIGHT_HEALTH * health + WEIGHT_GROWTH * growth
  return Math.max(0, Math.min(100, Math.round(blended)))
}

interface AssembleArgs {
  symbol: string
}

interface StreamArgs extends AssembleArgs {
  signal?: AbortSignal
}

/**
 * Stream the assembly of a deep risk report. Yields events as upstream
 * fetches resolve so the page can render sections progressively instead of
 * blocking on a 30–60s cold call.
 *
 * Order: meta → (price | chart | fundamentals as they resolve) → llm → done
 *
 * Errors per source emit as non-fatal `error` events so a moomoo outage
 * doesn't kill the report — the LLM still runs on whatever bundle exists.
 */
export async function* streamRiskReport({ symbol, signal }: StreamArgs): AsyncGenerator<RiskReportEvent> {
  if (signal?.aborted) return

  // Kick off every upstream call up-front so they overlap. Yield events as
  // each branch resolves; the LLM call waits for snapshot+kline+yahoo bundle.
  const snapshotP = fetchSnapshotCached(symbol).catch((err) => {
    console.error('[risk-report] snapshot failed', symbol, err)
    return null
  })
  const klineP = fetchKlineCached(symbol).catch((err) => {
    console.error('[risk-report] kline failed', symbol, err)
    return null
  })
  const metricsP = getFinancialMetrics(symbol)
  const quarterlyP = getQuarterlyHistory(symbol, 8)
  const earningsP = getEarningsInfo(symbol)
  const newsP = getCompanyNews(symbol, 30)

  // meta: emit symbol immediately so the header can paint while name resolves
  yield { kind: 'meta', symbol, name: null }

  // Race the three independent groups (snapshot, kline, yahoo bundle) and
  // emit each as it lands. The LLM call goes after all three.
  type Branch = 'snapshot' | 'kline' | 'yahoo'
  const branches = new Map<Branch, Promise<{ branch: Branch, value: unknown }>>([
    ['snapshot', snapshotP.then(v => ({ branch: 'snapshot' as Branch, value: v }))],
    ['kline', klineP.then(v => ({ branch: 'kline' as Branch, value: v }))],
    ['yahoo', Promise.all([metricsP, quarterlyP, earningsP, newsP]).then(v => ({ branch: 'yahoo' as Branch, value: v }))],
  ])

  let snapshot: Snapshot | null = null
  let bars: PriceBar[] = []
  let metrics!: Awaited<typeof metricsP>
  let quarterlyRaw!: Awaited<typeof quarterlyP>
  let earnings!: Awaited<typeof earningsP>
  let news!: Awaited<typeof newsP>

  while (branches.size > 0) {
    if (signal?.aborted) return
    const winner = await Promise.race([...branches.values()])
    branches.delete(winner.branch)

    if (winner.branch === 'snapshot') {
      snapshot = winner.value as Snapshot | null
      const price = {
        last: snapshot?.lastPrice ?? null,
        change: snapshot && snapshot.lastPrice !== null && snapshot.prevClosePrice !== null
          ? snapshot.lastPrice - snapshot.prevClosePrice
          : null,
        change_pct: snapshot?.changeRate ?? null,
        currency: 'USD',
      }
      yield { kind: 'meta', symbol, name: snapshot?.name ?? null }
      yield { kind: 'price', price }
    } else if (winner.branch === 'kline') {
      const klineRes = winner.value as KLineResponse | null
      bars = klineRes?.bars
        ? klineRes.bars.map(b => ({
            time: typeof b.time === 'string' ? b.time : new Date(b.time as unknown as string).toISOString(),
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          }))
        : []
      yield { kind: 'chart', bars }
    } else {
      const tuple = winner.value as [typeof metrics, typeof quarterlyRaw, typeof earnings, typeof news]
      metrics = tuple[0]
      quarterlyRaw = tuple[1]
      earnings = tuple[2]
      news = tuple[3]
      yield {
        kind: 'fundamentals',
        quarterly: buildQuarterlyRows(quarterlyRaw),
        earnings_update: buildEarningsUpdate(earnings, news),
      }
    }
  }

  if (signal?.aborted) return

  // All upstream done — fire LLM. This is the slow leg (~30-40s) but the
  // page already has price + chart + fundamentals painted by now.
  const price = {
    last: snapshot?.lastPrice ?? null,
    change: snapshot && snapshot.lastPrice !== null && snapshot.prevClosePrice !== null
      ? snapshot.lastPrice - snapshot.prevClosePrice
      : null,
    change_pct: snapshot?.changeRate ?? null,
    currency: 'USD',
  }
  let llm: Awaited<ReturnType<typeof generateRiskReport>>['llm']
  try {
    const llmResult = await generateRiskReport({
      symbol,
      name: snapshot?.name ?? null,
      price,
      metrics,
      earnings,
      news,
      chart_summary: buildChartSummary(bars, earnings),
    })
    llm = llmResult.llm
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    yield { kind: 'error', source: 'llm', message, fatal: true }
    return
  }

  if (signal?.aborted) return

  yield {
    kind: 'llm',
    kpis: llm.kpis,
    valuation: llm.valuation,
    health: llm.health,
    growth: llm.growth,
    markers: llm.markers,
    catalysts: llm.catalysts,
    risks: llm.risks,
    bottom_line: llm.bottom_line,
    rating: llm.rating,
  }

  const risk_score = blendRiskScore(llm.valuation.score, llm.health.score, llm.growth.score)
  const generated_at = new Date().toISOString()

  yield { kind: 'done', risk_score, generated_at }
}

/**
 * Synchronous one-shot wrapper around `streamRiskReport`. Drains the
 * generator and returns the assembled `RiskReport`. Useful for any caller
 * that wants a single Promise instead of an SSE stream.
 */
export async function assembleRiskReport({ symbol }: AssembleArgs): Promise<RiskReport> {
  let meta: { symbol: string, name: string | null } = { symbol, name: null }
  let price: RiskReport['price'] = { last: null, change: null, change_pct: null, currency: 'USD' }
  let bars: PriceBar[] = []
  let quarterly: QuarterlyRow[] = []
  let earnings_update: RiskReport['earnings_update'] = null
  let llm: Extract<RiskReportEvent, { kind: 'llm' }> | null = null
  let risk_score = 0
  let generated_at = new Date().toISOString()

  for await (const ev of streamRiskReport({ symbol })) {
    switch (ev.kind) {
      case 'cached':
        return ev.report
      case 'meta':
        meta = { symbol: ev.symbol, name: ev.name }
        break
      case 'price':
        price = ev.price
        break
      case 'chart':
        bars = ev.bars
        break
      case 'fundamentals':
        quarterly = ev.quarterly
        earnings_update = ev.earnings_update
        break
      case 'llm':
        llm = ev
        break
      case 'done':
        risk_score = ev.risk_score
        generated_at = ev.generated_at
        break
      case 'error':
        if (ev.fatal) throw new Error(ev.message)
        break
    }
  }

  if (!llm) throw new Error('risk-report stream ended without an llm event')
  return {
    symbol: meta.symbol,
    name: meta.name,
    generated_at,
    cached: false,
    price,
    chart: { bars, markers: llm.markers },
    kpis: llm.kpis,
    valuation: llm.valuation,
    health: llm.health,
    growth: llm.growth,
    risk_score,
    quarterly,
    earnings_update,
    catalysts: llm.catalysts,
    risks: llm.risks,
    bottom_line: llm.bottom_line,
    rating: llm.rating,
  }
}

// Convert Yahoo quarterly rows into the page's QuarterlyRow shape, computing
// YoY deltas by matching each quarter against the same calendar quarter four
// rows back.
function buildQuarterlyRows(rows: Awaited<ReturnType<typeof getQuarterlyHistory>>): QuarterlyRow[] {
  const out: QuarterlyRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (!r) continue
    const prior = rows[i + 4] ?? null
    out.push({
      period: r.period,
      revenue: r.revenue,
      revenue_yoy: prior && prior.revenue && r.revenue ? (r.revenue - prior.revenue) / prior.revenue : null,
      eps: r.eps,
      eps_yoy: prior && prior.eps !== null && prior.eps !== 0 && r.eps !== null ? (r.eps - prior.eps) / Math.abs(prior.eps) : null,
      margin: r.revenue && r.operating_income !== null ? r.operating_income / r.revenue : null,
    })
  }
  return out
}

function buildEarningsUpdate(
  earnings: Awaited<ReturnType<typeof getEarningsInfo>>,
  news: Awaited<ReturnType<typeof getCompanyNews>>,
): RiskReport['earnings_update'] {
  if (!earnings.last_earnings_date) {
    // No earnings record — fall back to the most recent news headline.
    const top = news[0]
    return top
      ? { headline: top.title, date: top.published_at.slice(0, 10), body: '' }
      : null
  }
  const surprise = earnings.last_eps_surprise_pct
  const headline = surprise !== null
    ? `Last quarter EPS ${surprise >= 0 ? 'beat' : 'miss'} of ${(surprise * 100).toFixed(1)}%`
    : 'Last quarter results reported'
  const body = [
    earnings.last_eps_actual !== null ? `Actual EPS: ${earnings.last_eps_actual}` : '',
    earnings.last_eps_estimate !== null ? `Consensus: ${earnings.last_eps_estimate}` : '',
    earnings.next_earnings_date ? `Next earnings: ${earnings.next_earnings_date}` : '',
  ].filter(Boolean).join(' · ')
  return { headline, date: earnings.last_earnings_date, body }
}
