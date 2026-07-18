export interface SlashArg { name: string; kind: 'symbol' | 'person' | 'text'; required: boolean }
export interface SlashCommand { name: string; tool: string; description: string; args: SlashArg[]; preset?: string }

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'investment-research', tool: 'investment_research', preset: 'research',
    description: 'Deep research memo on a company (business, financials, valuation, bull/bear, risks, verdict).',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'investment-team', tool: 'investment_research', preset: 'team',
    description: 'Research memo with explicit bull / bear / quant / macro lenses.',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'deep-company-series', tool: 'investment_research', preset: 'series',
    description: 'Long-form deep-dive memo (optionally continued in parts).',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'management-deep-dive', tool: 'investment_research', preset: 'management',
    description: 'Management / founder + capital-allocation deep dive (includes a web bio search).',
    args: [{ name: 'person', kind: 'person', required: true }, { name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'news-pulse', tool: 'news_pulse',
    description: 'Grouped news digest (ticker + macro + sector/peer) for a symbol.',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'thesis-tracker', tool: 'thesis_tracker',
    description: 'Read-only research history: latest verdict, confidence trend, staleness, realized alpha.',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'dyp-ask', tool: 'dyp_ask',
    description: 'First-principles reasoning answer to a pointed investment question.',
    args: [{ name: 'question', kind: 'text', required: true }] },
  { name: 'technical-analysis', tool: 'technical_analysis',
    description: 'Deterministic TA snapshot: SMA ladder, MACD, RSI, Bollinger, ATR, stochastic, OBV, support/resistance + signals.',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
  { name: 'ta', tool: 'technical_analysis',
    description: 'Alias of /technical-analysis.',
    args: [{ name: 'symbol', kind: 'symbol', required: true }] },
]

const BY_NAME = new Map(SLASH_COMMANDS.map(c => [c.name, c]))

export interface ParsedSlash { command: SlashCommand; args: Record<string, string> }

/**
 * Parse a leading-slash command line. The grammar is positional and tiny:
 *   - a single `text` arg consumes the entire rest of the line (e.g. dyp-ask).
 *   - otherwise each whitespace-separated token fills the next declared arg,
 *     in order; the LAST declared arg soaks up any remaining tokens (so a
 *     multi-word company name still lands in `symbol`).
 * Returns null for non-slash input or an unknown command.
 */
export function parseSlashCommand(text: string): ParsedSlash | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const firstSpace = trimmed.search(/\s/)
  const name = (firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace)).toLowerCase()
  const command = BY_NAME.get(name)
  if (!command) return null
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim()

  const args: Record<string, string> = {}
  if (command.args.length === 1 && command.args[0]!.kind === 'text') {
    args[command.args[0]!.name] = rest
    return { command, args }
  }
  const tokens = rest.length ? rest.split(/\s+/) : []
  command.args.forEach((arg, i) => {
    if (i === command.args.length - 1) {
      args[arg.name] = tokens.slice(i).join(' ')   // last arg soaks up the remainder
    } else {
      args[arg.name] = tokens[i] ?? ''
    }
  })
  return { command, args }
}
