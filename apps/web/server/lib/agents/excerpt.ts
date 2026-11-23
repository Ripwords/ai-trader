/**
 * Bounded, verbatim excerpts of an agent's markdown. A debate turn or a
 * ruling runs to thousands of characters; the chat needs the figures and
 * levels from it, not its opening paragraphs. Nothing here rewrites text:
 * every kept sentence or bullet is whole and in its original order.
 *
 * A debater restates an opponent and then answers. An excerpt has to read as
 * the speaker's own argument, so a restated claim is never kept, and a
 * sentence that leans on the one before it is kept only together with it.
 */

export interface Excerpt {
  text: string
  /**
   * `full`: the source fitted. `key-points`: the points carrying figures.
   * `passage`: one unbroken stretch of a paragraph, for prose with no headings
   * or bullets to give a lone sentence its topic. `head`: no figures to rank
   * by, so the opening sentences.
   */
  mode: 'full' | 'key-points' | 'passage' | 'head'
}

interface Point {
  text: string
  heading: string | null
  paragraph: number
  /** A sentence of running prose, as opposed to a bullet or a table row. */
  prose: boolean
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
    for (const text of splitSentences(prose.join(' '))) points.push({ text, heading, paragraph, prose: true })
    prose = []
    paragraph++
  }
  const point = (text: string) => {
    flush()
    points.push({ text, heading, paragraph: paragraph++, prose: false })
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

// A quoted sentence, or a quote introduced by a colon: someone else's claim, set up to be answered.
const QUOTED_CLAIM = /["“][^"”]{8,}[.!?]["”]|:\s*["“]/
// A connective or pronoun opening, or an interjection answering someone ("No — …", but not "No new capital").
const LEANS_BACK = /^(?:(?:but|yet|however|and|so|or|nor|still|instead|then|now|also|because|that|this|these|those|it|they|he|she|which|both|neither|either)\b|(?:yes|no|fine|true|agreed|sure|granted)\s*[,.:;—–-])/i

/**
 * For each point, the run of points that must be kept with it: itself, plus
 * the sentences before it in its paragraph that it leans on. `null` when the
 * point restates someone else, or leans on a restatement or on nothing.
 */
function standaloneRuns(points: Point[], restates: RegExp | undefined): (number[] | null)[] {
  const restated = points.map(p => QUOTED_CLAIM.test(p.text) || (restates?.test(p.text) ?? false))
  const runs: (number[] | null)[] = []
  points.forEach((p, i) => {
    const before = points[i - 1]?.paragraph === p.paragraph ? i - 1 : null
    const leans = LEANS_BACK.test(p.text) || (before !== null && (restated[before]! || points[before]!.text.endsWith('?')))
    if (restated[i]) runs.push(null)
    else if (!leans) runs.push([i])
    else runs.push(before !== null && runs[before] ? [...runs[before]!, i] : null)
  })
  return runs
}

function render(lead: Point[], kept: Point[], points: Point[]): string {
  const lines: string[] = []
  if (lead.length) lines.push(lead.map(p => p.text).join(' '))
  let heading: string | null = null
  let previous: Point | null = null
  for (const p of kept) {
    if (p.heading && p.heading !== heading) lines.push(...(lines.length ? ['', p.heading] : [p.heading]))
    const continues = previous?.paragraph === p.paragraph && points.indexOf(previous) === points.indexOf(p) - 1
    if (continues) lines[lines.length - 1] += ` ${p.text}`
    else lines.push(`- ${p.text}`)
    heading = p.heading
    previous = p
  }
  return lines.join('\n')
}

/** The stretch of one paragraph that fits and carries the most figures, opening on a sentence that stands alone. */
function bestPassage(points: Point[], runs: (number[] | null)[], maxChars: number): string | null {
  let best = { text: '', figures: 0 }
  runs.forEach((run, start) => {
    if (run?.length !== 1) return
    let text = ''
    for (let i = start; i < points.length && runs[i] && points[i]!.paragraph === points[start]!.paragraph; i++) {
      const next = text ? `${text} ${points[i]!.text}` : points[i]!.text
      if (next.length > maxChars) break
      text = next
    }
    const figures = figuresIn(text).size
    if (figures > best.figures) best = { text, figures }
  })
  return best.figures > 0 ? best.text : null
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

export interface ExcerptOptions {
  maxChars: number
  leadChars?: number
  /** Matches a point that restates another speaker ("The bull says…"). */
  restates?: RegExp
}

/**
 * Cut `source` to `maxChars`. With `leadChars`, the opening paragraph is kept
 * first (a ruling states its call there); the rest of the budget goes to the
 * points that add the most figures, each under the heading it sat under.
 */
export function excerptKeyPoints(source: string, opts: ExcerptOptions): Excerpt {
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

  const runs = standaloneRuns(points, opts.restates)

  if (lead.length === 0 && points.every(p => p.prose && p.heading === null)) {
    const passage = bestPassage(points, runs, opts.maxChars)
    if (passage) return { text: passage, mode: 'passage' }
  }

  // Greedy cover: each round takes the run that adds the most figures not
  // yet kept, per unit of length, so a recap repeating the same numbers does
  // not crowd out a line stating a level nobody else stated.
  const candidates = runs.flatMap((run, index) => {
    if (!run || lead.includes(points[index]!)) return []
    const figures = new Set(run.flatMap(i => [...figuresIn(points[i]!.text)]))
    return figures.size > 0 ? [{ run, figures }] : []
  })
  const covered = new Set(lead.flatMap(p => [...figuresIn(p.text)]))
  let kept = new Set<number>()
  const pointsOf = (indexes: Set<number>) => [...indexes].sort((a, b) => a - b).map(i => points[i]!)
  while (candidates.length) {
    const gain = (c: (typeof candidates)[number]) => {
      const added = c.run.filter(i => !kept.has(i)).reduce((n, i) => n + points[i]!.text.length, 0)
      return added === 0 ? 0 : [...c.figures].filter(f => !covered.has(f)).length / Math.sqrt(added)
    }
    const best = candidates.reduce((a, b) => (gain(b) > gain(a) ? b : a))
    candidates.splice(candidates.indexOf(best), 1)
    if (gain(best) === 0) break
    const trial = new Set([...kept, ...best.run])
    if (render(lead, pointsOf(trial), points).length > opts.maxChars) continue
    kept = trial
    for (const f of best.figures) covered.add(f)
  }
  if (kept.size === 0) {
    const first = runs.findIndex(run => run?.length === 1)
    const opening = points.slice(Math.max(0, first))
    const stop = opening.findIndex((_, i) => runs[Math.max(0, first) + i] === null)
    return { text: head(first === -1 || stop <= 0 ? opening : opening.slice(0, stop), opts.maxChars), mode: 'head' }
  }
  return { text: render(lead, pointsOf(kept), points), mode: 'key-points' }
}
