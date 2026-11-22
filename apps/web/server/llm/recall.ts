import type { LatestRunSummary, ResearchedSymbol } from '../lib/agents/runs-query'

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

// Tickers and company names that are also words a trader types. A lowercase
// "now" or "target" is the word; NOW or $now is the ticker.
const EVERYDAY_WORDS = new Set([
  'all', 'any', 'beat', 'best', 'block', 'both', 'box', 'can', 'care', 'cash', 'core', 'cost', 'earn', 'edge',
  'even', 'ever', 'fast', 'fund', 'gap', 'gold', 'good', 'grow', 'has', 'key', 'life', 'love', 'low', 'main',
  'match', 'new', 'next', 'now', 'one', 'open', 'out', 'path', 'peak', 'plan', 'play', 'post', 'real', 'run',
  'safe', 'see', 'square', 'target', 'tell', 'true', 'two', 'well',
])

const CORPORATE_SUFFIX = /(?:[\s,]+(?:inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|holdings?|group|technologies|technology|platforms)\.?|\.com)$/i

/** "Amazon.com, Inc." is "Amazon" in conversation. */
function spokenCompanyName(name: string): string {
  let spoken = name.trim()
  while (CORPORATE_SUFFIX.test(spoken)) spoken = spoken.replace(CORPORATE_SUFFIX, '')
  return spoken
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function firstMention(text: string, { symbol, companyName }: ResearchedSymbol): number | null {
  const ticker = symbol.replace(/^[A-Z]{2}\./, '')
  const positions: number[] = []
  const find = (pattern: string, accept: (written: string) => boolean = () => true) => {
    for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9.])${pattern}(?![A-Za-z0-9])`, 'gi'))) {
      if (accept(m[0])) positions.push(m.index)
    }
  }
  const everyday = (word: string) => EVERYDAY_WORDS.has(word.toLowerCase())

  if (symbol !== ticker) find(escapeRegExp(symbol))
  find(`\\$${escapeRegExp(ticker)}`)
  find(escapeRegExp(ticker), written =>
    !STOPWORDS.has(ticker) && (written === ticker || (ticker.length >= 3 && !everyday(ticker))))
  const name = companyName ? spokenCompanyName(companyName) : ''
  if (name.length >= 4 && !everyday(name)) find(escapeRegExp(name))

  return positions.length ? Math.min(...positions) : null
}

/**
 * Which of the symbols the user has researched does `text` mention: by full
 * symbol, cashtag, bare ticker in any case, or company name. Matching against
 * what was researched, not against anything ticker-shaped, is what lets a
 * lowercase "nvda" or "amazon" count without every short word becoming a hit.
 * Ordered by first mention.
 */
export function matchResearchedSymbols(text: string, researched: ResearchedSymbol[], max = 3): string[] {
  return researched
    .map(r => ({ symbol: r.symbol, at: firstMention(text, r) }))
    .filter((m): m is { symbol: string; at: number } => m.at !== null)
    .sort((a, b) => a.at - b.at)
    .slice(0, max)
    .map(m => m.symbol)
}

/** One compact hint line for the system prompt. */
export function formatRecallLine(s: LatestRunSummary, nowMs: number): string {
  const cap = s.originalRating ? ` (valuation capped it from ${s.originalRating})` : ''
  const confidence = s.confidence === null ? 'no confidence score' : `${s.confidence}% 7-trading-day probability`
  const verdict = s.rating ? `${s.rating}${cap}, ${confidence}` : s.status
  return `${s.symbol} — research ${ageText(s.finishedAt, nowMs)}: ${verdict} (run ${s.runId})`
}

/**
 * The recent-run hint block for the researched symbols `text` mentions: each
 * one's latest complete run. Returns '' when nothing matches, and callers
 * omit the block.
 */
export async function buildRecallContext(opts: { userId: string; text: string }): Promise<string> {
  if (!opts.text.trim()) return ''
  const { getLatestRunForSymbol, listResearchedSymbols } = await import('../lib/agents/runs-query')
  const symbols = matchResearchedSymbols(opts.text, await listResearchedSymbols(opts.userId))
  const runs = await Promise.all(symbols.map(symbol => getLatestRunForSymbol(opts.userId, symbol)))
  const nowMs = Date.now()
  const lines = new Map<string, string>()
  for (const run of runs) if (run) lines.set(run.runId, formatRecallLine(run, nowMs))
  return [...lines.values()].join('\n')
}

