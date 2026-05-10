// ── Deep risk-score report ──────────────────────────────────────────────
// Single struct returned by /api/research/deep-report and rendered by
// /research/[symbol]/report. Numeric fields (price, bar OHLC, raw quarterly
// figures) flow through from APIs unchanged. The LLM owns pillar scores +
// cards + rationale + KPI tones + chart markers + catalysts/risks bullets +
// bottom_line + rating. The final risk_score is recomputed in the Nuxt
// route as a deterministic 35/35/30 blend of the three pillar scores so
// the score-breakdown bars always equal the displayed total.
export type RiskCardTone = 'beat' | 'miss' | 'caution'
export type RiskRating = 'strong-buy' | 'buy' | 'hold' | 'reduce' | 'sell'
export type ChartMarkerKind = 'earnings' | 'split' | 'guidance' | 'news'

export interface RiskCard {
  label: string
  value: string
  tone: RiskCardTone
  note: string
}

export interface RiskPillar {
  score: number
  cards: RiskCard[]
  rationale: string
}

export interface QuarterlyRow {
  period: string
  revenue: number | null
  revenue_yoy: number | null
  eps: number | null
  eps_yoy: number | null
  margin: number | null
}

export interface ChartMarker {
  time: string
  kind: ChartMarkerKind
  label: string
}

export interface PriceBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

// SSE events emitted by /api/research/deep-report/stream. The page composes
// the final report progressively as these land. `cached` is terminal (full
// payload from the row cache) — when present, no other events fire.
// Otherwise: meta first, then price + chart + fundamentals in arbitrary
// order as upstream calls resolve, then llm once all inputs are ready, then
// done with the deterministic blended risk_score.
export type RiskReportEvent =
  | { kind: 'cached', report: RiskReport }
  | { kind: 'meta', symbol: string, name: string | null }
  | { kind: 'price', price: { last: number | null, change: number | null, change_pct: number | null, currency: string } }
  | { kind: 'chart', bars: PriceBar[] }
  | { kind: 'fundamentals', quarterly: QuarterlyRow[], earnings_update: { headline: string, date: string, body: string } | null }
  | { kind: 'llm', kpis: { label: string, value: string, tone: RiskCardTone }[], valuation: RiskPillar, health: RiskPillar, growth: RiskPillar, markers: ChartMarker[], catalysts: string[], risks: string[], bottom_line: string, rating: RiskRating }
  | { kind: 'done', risk_score: number, generated_at: string }
  | { kind: 'error', source: 'snapshot' | 'kline' | 'yahoo' | 'llm' | 'pipeline', message: string, fatal: boolean }

export interface RiskReport {
  symbol: string
  name: string | null
  generated_at: string
  cached: boolean
  price: {
    last: number | null
    change: number | null
    change_pct: number | null
    currency: string
  }
  chart: {
    bars: PriceBar[]
    markers: ChartMarker[]
  }
  kpis: { label: string, value: string, tone: RiskCardTone }[]
  valuation: RiskPillar
  health: RiskPillar
  growth: RiskPillar
  risk_score: number
  quarterly: QuarterlyRow[]
  earnings_update: { headline: string, date: string, body: string } | null
  catalysts: string[]
  risks: string[]
  bottom_line: string
  rating: RiskRating
}
