export interface Signal {
  source: string
  symbol: string
  signal: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  reasoning: string
  metadata?: Record<string, unknown>
}

export interface Persona {
  id: string
  displayName: string
  style: string
  prompt: string
}
