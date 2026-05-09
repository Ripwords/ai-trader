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
