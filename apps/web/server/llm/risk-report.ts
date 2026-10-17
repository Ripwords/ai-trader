// Deep risk-score report LLM call. Single generateObject pass that takes a
// pre-assembled bundle (moomoo snapshot + 12mo k-line + Yahoo metrics +
// Yahoo earnings + Yahoo news) and returns the LLM-owned subset of the
// RiskReport shape: pillar scores + cards + rationale, KPI tones, chart
// markers, catalysts, risks, bottom_line, rating.
//
// The deterministic 35/35/30 blend that produces the final risk_score lives
// in server/lib/risk-report.ts, not here — the LLM never sees the weights.

import { generateObject } from 'ai'
import { z } from 'zod'
import { recordUsageSafely } from '../lib/llm-cost'
import { getPrompt } from '../lib/prompts'
import type { EarningsInfo, FinancialMetrics, NewsItem } from '../lib/yahoo'
import { resolveModel } from './model'
import type { ChartMarker, PriceBar, RiskCardTone, RiskRating } from '../../types/research'

const RiskCardToneSchema = z.enum(['beat', 'miss', 'caution'])
const RiskRatingSchema = z.enum(['strong-buy', 'buy', 'hold', 'reduce', 'sell'])
const ChartMarkerKindSchema = z.enum(['earnings', 'split', 'guidance', 'news'])

const RiskCardSchema = z.object({
  label: z.string(),
  value: z.string(),
  tone: RiskCardToneSchema,
  note: z.string(),
})

const RiskPillarSchema = z.object({
  score: z.number().int().min(0).max(100),
  cards: z.array(RiskCardSchema).min(1).max(4),
  rationale: z.string(),
})

const KpiSchema = z.object({
  label: z.string(),
  value: z.string(),
  tone: RiskCardToneSchema,
})

const ChartMarkerSchema = z.object({
  time: z.string(),
  kind: ChartMarkerKindSchema,
  label: z.string(),
})

const RiskReportLLMSchema = z.object({
  kpis: z.array(KpiSchema).min(2).max(6),
  valuation: RiskPillarSchema,
  health: RiskPillarSchema,
  growth: RiskPillarSchema,
  markers: z.array(ChartMarkerSchema).max(8),
  catalysts: z.array(z.string()).max(6),
  risks: z.array(z.string()).max(6),
  bottom_line: z.string(),
  rating: RiskRatingSchema,
})

export type RiskReportLLM = z.infer<typeof RiskReportLLMSchema>

export interface RiskReportLLMInput {
  symbol: string
  name: string | null
  price: { last: number | null, change: number | null, change_pct: number | null, currency: string }
  metrics: FinancialMetrics
  earnings: EarningsInfo
  news: NewsItem[]
  // Down-sampled bars (~36 weekly closes) and earnings dates so the model can
  // pick chart markers that align to actual bars, without eating the full
  // 252-day daily payload.
  chart_summary: {
    weekly_closes: { time: string, close: number }[]
    earnings_dates: string[]
  }
}

export async function generateRiskReport(input: RiskReportLLMInput): Promise<{
  llm: RiskReportLLM
  bars_marker_filtered: ChartMarker[]
}> {
  const prompt = [
    `Symbol: ${input.symbol}${input.name ? ` (${input.name})` : ''}`,
    `Price snapshot: ${JSON.stringify(input.price)}`,
    '',
    'Financial metrics (Yahoo):',
    JSON.stringify(input.metrics, null, 2),
    '',
    'Earnings info (Yahoo):',
    JSON.stringify(input.earnings, null, 2),
    '',
    `Recent news (${input.news.length} items):`,
    JSON.stringify(input.news.slice(0, 20), null, 2),
    '',
    'Chart summary (weekly closes + earnings dates) for marker placement:',
    JSON.stringify(input.chart_summary, null, 2),
  ].join('\n')

  const resolved = await resolveModel('chat')
  const { object, usage } = await generateObject({
    model: resolved.model,
    schema: RiskReportLLMSchema,
    system: await getPrompt('research.risk_report'),
    prompt,
  })

  if (usage) {
    await recordUsageSafely({
      source: 'risk-report',
      modelSpec: resolved.spec,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    })
  }

  return { llm: object, bars_marker_filtered: object.markers }
}

// Helpers exported for the route assembler — kept here so the prompt and
// the chart-summary projection live next to each other.
export function buildChartSummary(
  bars: PriceBar[],
  earnings: EarningsInfo,
): RiskReportLLMInput['chart_summary'] {
  const weekly: { time: string, close: number }[] = []
  // Take ~one bar per week for the LLM input.
  const stride = Math.max(1, Math.floor(bars.length / 52))
  for (let i = 0; i < bars.length; i += stride) {
    const b = bars[i]
    if (b) weekly.push({ time: b.time, close: b.close })
  }
  const dates: string[] = []
  if (earnings.last_earnings_date) dates.push(earnings.last_earnings_date)
  if (earnings.next_earnings_date) dates.push(earnings.next_earnings_date)
  return { weekly_closes: weekly, earnings_dates: dates }
}
