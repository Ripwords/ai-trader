import { getApiClient } from '../../llm/http'

interface DigestSignal {
  source: string
  symbol: string
  signal: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  reasoning: string
}

interface DigestDecision {
  symbol: string
  action: 'buy' | 'sell' | 'short' | 'cover' | 'hold'
  quantity: number
  confidence: number
  reasoning: string
}

interface DigestItem {
  symbol: string
  decision: DigestDecision | null
  signals: DigestSignal[]
  error: string | null
}

interface AnalyzeResponse {
  symbol: string
  signals: DigestSignal[]
  decision: DigestDecision | null
}

export default defineEventHandler(async (event) => {
  const body = await readBody<{ personas?: string[]; analysts?: string[]; group?: string }>(event)
  const personas = body?.personas ?? []
  const analysts = body?.analysts ?? ['fundamentals', 'valuation', 'technicals', 'sentiment']
  const group = body?.group ?? 'All'

  const watchlist = await getApiClient().listWatchlist({ group })
  const symbols = watchlist.map(w => w.code)

  const results: DigestItem[] = []
  for (const symbol of symbols) {
    try {
      const r = await $fetch<AnalyzeResponse>('/api/research/analyze', {
        method: 'POST',
        body: { symbol, analysts, personas },
        headers: { cookie: getRequestHeader(event, 'cookie') ?? '' },
      })
      results.push({ symbol, decision: r.decision, signals: r.signals, error: null })
    } catch (err) {
      const msg = err instanceof Error
        ? err.message
        : typeof err === 'object' && err !== null && 'statusMessage' in err
          ? String((err as { statusMessage?: unknown }).statusMessage ?? err)
          : String(err)
      results.push({ symbol, decision: null, signals: [], error: msg })
    }
  }

  const actionRank: Record<string, number> = { buy: 4, short: 3, sell: 2, cover: 1, hold: 0 }
  results.sort((a, b) => {
    const ar = a.decision ? (actionRank[a.decision.action] ?? 0) * 100 + a.decision.confidence : -1
    const br = b.decision ? (actionRank[b.decision.action] ?? 0) * 100 + b.decision.confidence : -1
    return br - ar
  })

  return { generated_at: new Date().toISOString(), items: results }
})
