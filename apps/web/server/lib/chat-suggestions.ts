export interface SuggestionSources {
  watchlist: Array<{ code: string; name: string | null }>
  positions: Array<{ symbol: string; name: string | null; pnlPct: number | null }>
  /** Alerts that fired recently. */
  triggeredAlerts: Array<{ symbol: string }>
}

export const SUGGESTION_COUNT = 4

export const DEFAULT_SUGGESTIONS: readonly string[] = [
  'Show me NVDA daily',
  'Any news on Arista Networks?',
  'What\'s on my watchlist?',
  'Show my paper portfolio',
]

const EVERGREEN: readonly string[] = [
  'What\'s on my watchlist?',
  'Show my paper portfolio',
  'Value-screen my watchlist',
]

type Rng = () => number

interface Symbol {
  symbol: string
  name: string | null
  pnlPct: number | null
  watched: boolean
}

// The tracker reports bare tickers ("AAPL", "1066.KL", "0700.HK") while moomoo
// and the watchlist use market-prefixed codes ("US.AAPL", "MY.1066",
// "HK.00700"). Both name the same company, so they collapse onto one key.
function symbolKey(code: string): string {
  return code
    .toUpperCase()
    .replace(/^[A-Z]{2}\./, '')
    .replace(/\.[A-Z]{1,2}$/, '')
    .replace(/^0+(?=\d)/, '')
}

function hasMarketPrefix(code: string): boolean {
  return /^[A-Z]{2}\./.test(code)
}

// Every distinct symbol the user watches or holds. The moomoo-style code wins
// as the display form because that is what the chart tool resolves, and the
// first non-null name wins.
function symbolRegistry(sources: SuggestionSources): Symbol[] {
  const byKey = new Map<string, Symbol>()
  const merge = (code: string, name: string | null, pnlPct: number | null, watched: boolean) => {
    const key = symbolKey(code)
    const prev = byKey.get(key)
    byKey.set(key, {
      symbol: prev && !hasMarketPrefix(code) ? prev.symbol : code,
      name: prev?.name ?? name,
      pnlPct: prev?.pnlPct ?? pnlPct,
      watched: (prev?.watched ?? false) || watched,
    })
  }
  for (const w of sources.watchlist) merge(w.code, w.name, null, true)
  for (const p of sources.positions) merge(p.symbol, p.name, p.pnlPct, false)
  return [...byKey.values()]
}

// Each filler takes the symbols already spent by earlier fillers so no ticker
// appears twice. Fill order is priority (the held position wins its symbol);
// `display` is where the result lands on the landing page.
type SlotFiller = (registry: Symbol[], alerts: SuggestionSources['triggeredAlerts'], used: Set<string>, rng: Rng) => string | null
interface Slot { fill: SlotFiller; display: number }

function pick<T>(items: readonly T[], rng: Rng): T | undefined {
  if (items.length === 0) return undefined
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]
}

function unused(all: Symbol[], used: Set<string>): Symbol[] {
  return all.filter(s => !used.has(symbolKey(s.symbol)))
}

function spend(used: Set<string>, symbol: string): void {
  used.add(symbolKey(symbol))
}

const chartSlot: SlotFiller = (registry, _alerts, used, rng) => {
  const s = pick(unused(registry.filter(x => x.watched), used), rng) ?? pick(unused(registry, used), rng)
  if (!s) return null
  spend(used, s.symbol)
  return `Show me ${s.symbol} daily`
}

const newsSlot: SlotFiller = (registry, _alerts, used, rng) => {
  const s = pick(unused(registry, used), rng)
  if (!s) return null
  spend(used, s.symbol)
  return `Any news on ${s.name ?? s.symbol}?`
}

const portfolioSlot: SlotFiller = (registry, alerts, used) => {
  const triggered = alerts.find(a => !used.has(symbolKey(a.symbol)))
  if (triggered) {
    spend(used, triggered.symbol)
    return `What happened with my ${triggered.symbol} alert?`
  }
  const mover = registry
    .filter(s => s.pnlPct != null)
    .sort((a, b) => Math.abs(b.pnlPct!) - Math.abs(a.pnlPct!))
    .find(s => !used.has(symbolKey(s.symbol)))
  if (mover) {
    spend(used, mover.symbol)
    return `How is my ${mover.symbol} position doing?`
  }
  return null
}

const evergreenSlot: SlotFiller = (_registry, _alerts, _used, rng) => pick(EVERGREEN, rng) ?? null

const SLOTS: readonly Slot[] = [
  { fill: portfolioSlot, display: 2 },
  { fill: chartSlot, display: 0 },
  { fill: newsSlot, display: 1 },
  { fill: evergreenSlot, display: 3 },
]

/**
 * Four opening prompts for an empty chat, drawn from what the user actually
 * watches, holds, and has alerts on. Falls back to the static list only when
 * every source is empty. `rng` is injectable so tests are deterministic and
 * each new chat can draw a different mix.
 */
export function buildSuggestions(sources: SuggestionSources, rng: Rng = Math.random): string[] {
  const registry = symbolRegistry(sources)
  if (registry.length === 0 && sources.triggeredAlerts.length === 0) return [...DEFAULT_SUGGESTIONS]

  const used = new Set<string>()
  const filled = SLOTS
    .map(slot => ({ display: slot.display, text: slot.fill(registry, sources.triggeredAlerts, used, rng) }))
    .sort((a, b) => a.display - b.display)

  const out: string[] = []
  const add = (s: string | null | undefined) => {
    if (s && !out.includes(s) && out.length < SUGGESTION_COUNT) out.push(s)
  }
  for (const f of filled) add(f.text)
  for (const s of EVERGREEN) add(s)
  for (const s of DEFAULT_SUGGESTIONS) add(s)
  return out
}
