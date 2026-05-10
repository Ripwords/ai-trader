// Bundle assembler + deterministic 35/35/30 blend for the deep risk-score
// report. The route fetches all upstream data here, hands the bundle to the
// LLM module, blends the final risk_score, and persists the result.

import { sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { riskReports } from '../../db/schema'
import { getApiClient } from '../llm/http'
import { buildChartSummary, generateRiskReport } from '../llm/risk-report'
import {
  getCompanyNews,
  getEarningsInfo,
  getFinancialMetrics,
  getQuarterlyHistory,
} from './yahoo'
import type { PriceBar, QuarterlyRow, RiskReport } from '../../types/research'

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
  ownerId: string
  symbol: string
  refresh: boolean
}

export async function assembleRiskReport({ ownerId, symbol, refresh }: AssembleArgs): Promise<RiskReport> {
  if (!refresh) {
    const cached = await loadCached(ownerId, symbol)
    if (cached) return { ...cached, cached: true }
  }

  const client = getApiClient()

  // moomoo + Yahoo in parallel. Each leg shields its own failure so the
  // page can still render with whatever data we got.
  const [snapshot, klineRes, metrics, quarterly, earnings, news] = await Promise.all([
    client.getSnapshot({ code: symbol }).catch((err) => {
      console.error('[risk-report] snapshot failed', symbol, err)
      return null
    }),
    client.getKline({ code: symbol, ktype: '1d', num: 252 }).catch((err) => {
      console.error('[risk-report] kline failed', symbol, err)
      return null
    }),
    getFinancialMetrics(symbol),
    getQuarterlyHistory(symbol, 8),
    getEarningsInfo(symbol),
    getCompanyNews(symbol, 30),
  ])

  const bars: PriceBar[] = klineRes?.bars
    ? klineRes.bars.map(b => ({
        time: typeof b.time === 'string' ? b.time : new Date(b.time as unknown as string).toISOString(),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }))
    : []

  const price = {
    last: snapshot?.lastPrice ?? null,
    change: snapshot && snapshot.lastPrice !== null && snapshot.prevClosePrice !== null
      ? snapshot.lastPrice - snapshot.prevClosePrice
      : null,
    change_pct: snapshot?.changeRate ?? null,
    currency: 'USD',
  }

  const llmResult = await generateRiskReport({
    symbol,
    name: snapshot?.name ?? null,
    price,
    metrics,
    earnings,
    news,
    chart_summary: buildChartSummary(bars, earnings),
  })
  const llm = llmResult.llm

  const quarterlyRows: QuarterlyRow[] = buildQuarterlyRows(quarterly)

  const report: RiskReport = {
    symbol,
    name: snapshot?.name ?? null,
    generated_at: new Date().toISOString(),
    cached: false,
    price,
    chart: { bars, markers: llm.markers },
    kpis: llm.kpis,
    valuation: llm.valuation,
    health: llm.health,
    growth: llm.growth,
    risk_score: blendRiskScore(llm.valuation.score, llm.health.score, llm.growth.score),
    quarterly: quarterlyRows,
    earnings_update: buildEarningsUpdate(earnings, news),
    catalysts: llm.catalysts,
    risks: llm.risks,
    bottom_line: llm.bottom_line,
    rating: llm.rating,
  }

  await saveCached(ownerId, symbol, report)
  return report
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

async function loadCached(ownerId: string, symbol: string): Promise<RiskReport | null> {
  const db = getDb()
  const today = new Date().toISOString().slice(0, 10)
  const rows = await db
    .select({ payload: riskReports.payload })
    .from(riskReports)
    .where(sql`${riskReports.userId} = ${ownerId} and ${riskReports.symbol} = ${symbol} and ${riskReports.day} = ${today}`)
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return row.payload as unknown as RiskReport
}

async function saveCached(ownerId: string, symbol: string, report: RiskReport): Promise<void> {
  const db = getDb()
  const today = new Date().toISOString().slice(0, 10)
  await db
    .insert(riskReports)
    .values({ userId: ownerId, symbol, day: today, payload: report })
    .onConflictDoUpdate({
      target: [riskReports.userId, riskReports.symbol, riskReports.day],
      set: { payload: report, createdAt: new Date() },
    })
}
