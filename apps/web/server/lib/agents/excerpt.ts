/**
 * Bounded, verbatim excerpts of an agent's markdown. A debate turn or a
 * ruling runs to thousands of characters; the chat needs the figures and
 * levels from it, not its opening paragraphs. Nothing here rewrites text:
 * every kept sentence or bullet is whole and in its original order.
 */

export interface Excerpt {
  text: string
  /** `full`: the source fitted. `key-points`: the points carrying figures. `head`: no figures to rank by, so the opening sentences. */
  mode: 'full' | 'key-points' | 'head'
}

interface Point {
  text: string
  heading: string | null
  paragraph: number
}

const ABBREVIATIONS = new Set([
  'vs', 'etc', 'approx', 'inc', 'corp', 'co', 'ltd', 'no', 'mr', 'mrs', 'ms', 'dr', 'st', 'est', 'fig',
])

function endsWithAbbreviation(before: string): boolean {
  const token = (before.split(/\s/).at(-1) ?? '').replace(/^[("“'‘[]+/, '').toLowerCase()
  return token.length === 1 || /^(?:[a-z]\.)+[a-z]$/.test(token) || ABBREVIATIONS.has(token)
}

/** A sentence ends at `.`, `!` or `?` followed by whitespace, so a decimal point never ends one. */
export function splitSentences(paragraph: string): string[] {
  const out: string[] = []
  let start = 0
  for (const m of paragraph.matchAll(/[.!?]["”’)\]]*\s+(?=["“(\[]?[A-Z$\d])/g)) {
    if (m[0].startsWith('.') && endsWithAbbreviation(paragraph.slice(start, m.index))) continue
    out.push(paragraph.slice(start, m.index + m[0].trimEnd().length).trim())
    start = m.index + m[0].length
  }
  const tail = paragraph.slice(start).trim()
  if (tail) out.push(tail)
  return out
}

const HEADING = /^#{1,6}\s+(.+?)\s*#*$/
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+(.+)$/
const TABLE_ROW = /^\|(.+)\|$/
const RULE_OR_TABLE_DIVIDER = /^\|?[\s:|-]*-[\s:|-]*\|?$/
const QUOTE = /^>\s?(.*)$/
// The risk manager's contract line; the rating field already carries it.
const CONTRACT_LINE = /^FINAL TRANSACTION PROPOSAL/i

function clean(source: string): string[] {
  return source
    .replaceAll(/\*\*|__/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => !CONTRACT_LINE.test(line))
}

function parsePoints(lines: string[]): Point[] {
  const points: Point[] = []
  let heading: string | null = null
  let paragraph = 0
  let prose: string[] = []
  const flush = () => {
    if (prose.length === 0) return
    for (const text of splitSentences(prose.join(' '))) points.push({ text, heading, paragraph })
    prose = []
    paragraph++
  }
  const point = (text: string) => {
    flush()
    points.push({ text, heading, paragraph: paragraph++ })
  }

  for (const line of lines) {
    if (!line || RULE_OR_TABLE_DIVIDER.test(line)) {
      flush()
      continue
    }
    const title = HEADING.exec(line)?.[1] ?? (prose.length === 0 && line.length <= 80 && line.endsWith(':') ? line : null)
    if (title) {
      flush()
      heading = title.replace(/:$/, '')
      continue
    }
    const row = TABLE_ROW.exec(line)
    if (row) {
      point(row[1]!.split('|').map(cell => cell.trim()).join(' | '))
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      point(bullet[1]!)
      continue
    }
    prose.push(QUOTE.exec(line)?.[1] ?? line)
  }
  flush()
  return points
}

const FIGURE = /\d[\d,]*(?:\.\d+)?/g

const figuresIn = (text: string) => new Set(text.match(FIGURE) ?? [])

function render(lead: Point[], kept: Point[]): string {
  const lines: string[] = []
  if (lead.length) lines.push(lead.map(p => p.text).join(' '))
  let heading: string | null = null
  for (const p of kept) {
    if (p.heading && p.heading !== heading) lines.push(...(lines.length ? ['', p.heading] : [p.heading]))
    heading = p.heading
    lines.push(`- ${p.text}`)
  }
  return lines.join('\n')
}

const hasDigit = (word: string | undefined) => word !== undefined && /\d/.test(word)

/** Cut at a word, backing off past a figure and the unit after it ("$28.08 billion"). */
function cutAtWord(text: string, maxChars: number): string {
  const words = text.split(/\s+/)
  let end = 0
  let length = 0
  while (end < words.length && length + words[end]!.length + (end ? 1 : 0) <= maxChars - 1) {
    length += words[end]!.length + (end ? 1 : 0)
    end++
  }
  while (end > 0 && (hasDigit(words[end - 1]) || hasDigit(words[end - 2]))) end--
  return `${words.slice(0, end).join(' ')}…`
}

function head(points: Point[], maxChars: number): string {
  let text = ''
  for (const p of points) {
    const next = text ? `${text} ${p.text}` : p.text
    if (next.length > maxChars) break
    text = next
  }
  return text || cutAtWord(points[0]?.text ?? '', maxChars)
}

/**
 * Cut `source` to `maxChars`. With `leadChars`, the opening paragraph is kept
 * first (a ruling states its call there); the rest of the budget goes to the
 * points that add the most figures, each under the heading it sat under.
 */
export function excerptKeyPoints(source: string, opts: { maxChars: number; leadChars?: number }): Excerpt {
  const lines = clean(source)
  const whole = lines.join('\n').trim()
  if (whole.length <= opts.maxChars) return { text: whole, mode: 'full' }

  const points = parsePoints(lines)
  const lead: Point[] = []
  let leadLength = 0
  for (const p of points) {
    if (p.paragraph !== points[0]!.paragraph || leadLength + p.text.length + 1 > (opts.leadChars ?? 0)) break
    lead.push(p)
    leadLength += p.text.length + 1
  }

  // Greedy cover: each round takes the point that adds the most figures not
  // yet kept, per unit of length, so a recap repeating the same numbers does
  // not crowd out a line stating a level nobody else stated.
  const candidates = points
    .map((p, index) => ({ p, index, figures: figuresIn(p.text) }))
    .filter(c => c.figures.size > 0 && !lead.includes(c.p))
  const covered = new Set(lead.flatMap(p => [...figuresIn(p.text)]))
  let kept: typeof candidates = []
  while (candidates.length) {
    const gain = (c: (typeof candidates)[number]) =>
      [...c.figures].filter(f => !covered.has(f)).length / Math.sqrt(c.p.text.length)
    const best = candidates.reduce((a, b) => (gain(b) > gain(a) ? b : a))
    candidates.splice(candidates.indexOf(best), 1)
    if (gain(best) === 0) break
    const trial = [...kept, best].sort((a, b) => a.index - b.index)
    if (render(lead, trial.map(c => c.p)).length > opts.maxChars) continue
    kept = trial
    for (const f of best.figures) covered.add(f)
  }
  if (kept.length === 0) return { text: head(points, opts.maxChars), mode: 'head' }
  return { text: render(lead, kept.map(c => c.p)), mode: 'key-points' }
}
