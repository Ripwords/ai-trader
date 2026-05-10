export type SignalDirection = 'bullish' | 'bearish' | 'neutral'

export interface Signal {
  source: string
  symbol: string
  signal: SignalDirection
  confidence: number
  reasoning: string
}

export type DecisionAction = 'buy' | 'sell' | 'short' | 'cover' | 'hold'

export interface Decision {
  symbol: string
  action: DecisionAction
  quantity: number
  confidence: number
  reasoning: string
}

export type AnalystName = 'fundamentals' | 'valuation' | 'technicals' | 'sentiment'

export type PersonaName =
  | 'buffett'
  | 'munger'
  | 'burry'
  | 'druckenmiller'
  | 'wood'

export interface ResearchRunRequest {
  symbol: string
  analysts?: AnalystName[]
  personas?: PersonaName[]
}

export interface ResearchRunResponse {
  symbol: string
  signals: Signal[]
}

export type ResearchSourceName = AnalystName | PersonaName

export type ResearchEvent =
  | { kind: 'progress'; source: ResearchSourceName; phase: 'started' }
  | { kind: 'signal'; source: ResearchSourceName; signal: Signal }
  | { kind: 'error'; source: ResearchSourceName; message: string; fatal: boolean }
  | { kind: 'done' }

export interface SynthesisRequest {
  symbols: string[]
  signals: Signal[]
  portfolio?: unknown
}

export interface SynthesisResponse {
  decisions: Decision[]
}

export interface PortfolioLike {
  cash: number
  market_val: number
  total_assets: number
  positions: Array<{ code: string; qty: number; current_price: number }>
}

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
