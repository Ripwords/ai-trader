interface CompareSignal {
  source: string
  symbol: string
  signal: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  reasoning: string
}

interface CompareDecision {
  symbol: string
  action: 'buy' | 'sell' | 'short' | 'cover' | 'hold'
  quantity: number
  confidence: number
  reasoning: string
}

interface CompareItem {
  symbol: string
  decision: CompareDecision | null
  signals: CompareSignal[]
  error: string | null
}

interface AnalyzeResponse {
  symbol: string
  signals: CompareSignal[]
  decision: CompareDecision | null
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ symbols?: string[]; analysts?: string[]; personas?: string[] }>(event)
  const symbols = (body?.symbols ?? []).map(s => s.trim()).filter(Boolean).slice(0, 5)
  if (symbols.length < 2) {
    throw createError({ statusCode: 400, statusMessage: 'compare requires 2-5 symbols' })
  }
  const personas = body?.personas ?? []
  const analysts = body?.analysts ?? ['fundamentals', 'valuation', 'technicals', 'sentiment']
  const cookie = getRequestHeader(event, 'cookie') ?? ''

  // Sequential to be polite to upstream rate limits.
  const items: CompareItem[] = []
  for (const symbol of symbols) {
    try {
      const r = await $fetch<AnalyzeResponse>('/api/research/analyze', {
        method: 'POST',
        body: { symbol, analysts, personas },
        headers: { cookie },
      })
      items.push({ symbol, decision: r.decision, signals: r.signals, error: null })
    } catch (err) {
      const msg = err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'statusMessage' in err
          ? String((err as { statusMessage?: unknown }).statusMessage ?? err)
          : String(err)
      items.push({ symbol, decision: null, signals: [], error: msg })
    }
  }

  return { generated_at: new Date().toISOString(), items }
})
