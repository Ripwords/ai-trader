import type { LatestRunSummary } from '../lib/agents/runs-query'

// Uppercase words that look like tickers but almost never are, in a trading
// chat. Keeps the bare-word path from injecting noise.
const STOPWORDS = new Set([
  'A', 'I', 'OK', 'THE', 'AND', 'FOR', 'ARE', 'BUY', 'SELL', 'HOLD', 'ALL',
  'USD', 'HKD', 'MYR', 'EPS', 'PE', 'DCF', 'MPT', 'ETF', 'IPO', 'CEO', 'NYSE',
  'US', 'HK', 'SH', 'SZ', 'YES', 'NO', 'IT', 'IS', 'IF', 'OR', 'TO', 'OF',
])

/**
 * Extract probable ticker symbols from free text. Two sources:
 *   - cashtags ``$xyz`` (any case → uppercased) — high signal.
 *   - bare ALL-CAPS tokens 1-5 chars — medium signal, stopword-filtered.
 * Bare lowercase words are intentionally NOT matched: "buy aapl" would be too
 * noisy. Returns de-duplicated, order-preserving, capped to ``max``.
 */
export function extractTickerCandidates(text: string, max = 5): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const sym = raw.toUpperCase()
    if (sym.length < 1 || sym.length > 5) return
    if (STOPWORDS.has(sym)) return
    if (seen.has(sym)) return
    seen.add(sym)
    out.push(sym)
  }
  for (const m of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) push(m[1]!)
  for (const m of text.matchAll(/\b([A-Z]{1,5})\b/g)) push(m[1]!)
  return out.slice(0, max)
}

function ageText(finishedAtIso: string | null, nowMs: number): string {
  if (!finishedAtIso) return 'recently'
  const mins = Math.max(0, Math.round((nowMs - Date.parse(finishedAtIso)) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** One compact hint line for the system prompt. */
export function formatRecallLine(s: LatestRunSummary, nowMs: number): string {
  const verdict = s.rating
    ? `${s.rating}${s.confidence != null ? ` conf ${s.confidence}` : ''}`
    : s.status
  return `${s.symbol} — research ${ageText(s.finishedAt, nowMs)}: ${verdict} (run ${s.runId})`
}

/**
 * Build the recent-run hint block for the tickers mentioned in ``text``.
 * Validates candidates against the watchlist OR canonical resolution to kill
 * false positives, then looks up each symbol's latest non-running run. Returns
 * '' when nothing matches — callers omit the block entirely.
 */
export async function buildRecallContext(opts: { userId: string; text: string; watchlist: string[] }): Promise<string> {
  const { getLatestRunForSymbol } = await import('../lib/agents/runs-query')
  const { resolveSymbol } = await import('../lib/yahoo')
  const candidates = extractTickerCandidates(opts.text)
  if (candidates.length === 0) return ''

  const watch = new Set(opts.watchlist.map(w => w.toUpperCase()))
  const nowMs = Date.now()
  const lineOrNulls = await Promise.all(candidates.map(async (cand): Promise<string | null> => {
    // Cheap path: on the watchlist (bare symbol, possibly market-prefixed like US.NVDA).
    const onWatch = watch.has(cand) || [...watch].some(w => w.endsWith(`.${cand}`))
    let symbol = cand
    if (!onWatch) {
      const r = await resolveSymbol(cand)
      if (r.status !== 'resolved') return null
      symbol = r.symbol
    }
    const latest = await getLatestRunForSymbol(opts.userId, symbol)
      ?? (symbol !== cand ? await getLatestRunForSymbol(opts.userId, cand) : null)
    return latest ? formatRecallLine(latest, nowMs) : null
  }))
  return lineOrNulls.filter((l): l is string => l !== null).join('\n')
}
