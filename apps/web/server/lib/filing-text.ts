/**
 * SEC filing HTML → plain text an LLM can read, plus a section-aware
 * truncation that keeps what explains a quarter (headline bullets, guidance,
 * segment tables, cash flow) and drops boilerplate first.
 *
 * EDGAR exhibits are machine-generated HTML: every cell is a styled <td>,
 * "$" and the closing ")" of a negative number sit in their own cells, and
 * inline-XBRL documents carry a hidden <ix:header>. A regex pass handles that
 * regular shape without a DOM dependency.
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–',
  bull: '•', middot: '·', hellip: '…', reg: '®', trade: '™', copy: '©',
  shy: '', zwsp: '', ensp: ' ', emsp: ' ', thinsp: ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
      if (!Number.isFinite(n)) return whole
      if (n === 160) return ' '
      try {
        return String.fromCodePoint(n)
      } catch {
        return whole
      }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()]
    return named ?? whole
  })
}

function inlineText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/[\s ]+/g, ' ')
    .trim()
}

/** Glue "$" onto the next cell and ")" / "%" onto the previous one. */
function mergeCells(cells: string[]): string[] {
  const out: string[] = []
  let pendingPrefix = ''
  for (const raw of cells) {
    const c = raw.trim()
    if (!c) continue
    if (c === '$' || c === '€' || c === '£' || c === '¥') {
      pendingPrefix += c
      continue
    }
    if (/^(\)|%|\)%|%\))$/.test(c) && out.length > 0) {
      out[out.length - 1] += c
      continue
    }
    out.push(pendingPrefix + c)
    pendingPrefix = ''
  }
  return out
}

function tableToText(tableHtml: string): string {
  const rows: string[] = []
  for (const tr of tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(inlineText)
    const merged = mergeCells(cells)
    if (merged.length === 0) continue
    // A row whose first cell is empty is a column header: lead with "|" so
    // the reader sees the label column is blank.
    const firstEmpty = cells.length > 0 && !(cells[0] ?? '').trim()
    rows.push((firstEmpty ? '| ' : '') + merged.join(' | '))
  }
  return rows.join('\n')
}

export function filingHtmlToText(html: string): string {
  let s = html
    // EDGAR's SGML wrapper: unclosed tags whose value runs to the end of the line.
    .replace(/<(TYPE|SEQUENCE|FILENAME|DESCRIPTION)>[^\n<]*/g, '')
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, '')
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  // Tables first, so their cell structure survives the generic tag strip.
  const tables: string[] = []
  s = s.replace(/<table[\s\S]*?<\/table>/gi, (t) => {
    tables.push(tableToText(t))
    return `\n\u0000T${tables.length - 1}\u0000\n`
  })

  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  s = decodeEntities(s)

  const lines: string[] = []
  for (const rawLine of s.split('\n')) {
    const tableRef = rawLine.match(/\u0000T(\d+)\u0000/)
    if (tableRef) {
      const t = tables[Number(tableRef[1])]
      if (t) lines.push(...t.split('\n'))
      continue
    }
    const line = rawLine.replace(/[\s ]+/g, ' ').trim()
    if (!line) continue
    lines.push(line.replace(/^•\s*/, '• '))
  }
  return lines.join('\n')
}

// ─── section-aware truncation ───────────────────────────────────────────

interface Section {
  heading: string
  body: string
  order: number
  priority: number
}

// Lower is kept first. The first section (headline + highlight bullets) is
// always priority 0.
const PRIORITY_RULES: [RegExp, number][] = [
  [/forward[- ]looking|safe harbor|about [a-z0-9.,& ]+$|conference call|webcast|additional information|investor relations|contacts?$|media|non-gaap financial measures$/i, 9],
  [/guidance|outlook|expect/i, 1],
  [/segment/i, 1],
  [/cash flow/i, 1],
  [/highlights since|other highlights/i, 6],
  [/statements? of (operations|income|earnings)|income statement/i, 2],
  [/non-gaap|reconciliation|supplemental|free cash/i, 2],
  [/balance sheet|financial position|comprehensive income/i, 4],
]

function priorityOf(heading: string): number {
  for (const [re, p] of PRIORITY_RULES) if (re.test(heading)) return p
  return 5
}

// Sentence-case headings that releases use verbatim ("Some other highlights
// since the last earnings announcement include:").
const KEYWORD_HEADING = /^(some other highlights|other highlights|highlights|financial guidance|guidance|outlook|segment information|segment results|forward-looking statements|conference call|about [a-z]|additional information|consolidated statements? of|supplemental|reconciliation)/i

/** A short, title-like line that isn't a bullet, a table row or a sentence. */
function isHeading(line: string): boolean {
  if (line.length < 4 || line.length > 90) return false
  if (line.startsWith('•') || line.includes(' | ') || line.startsWith('|')) return false
  if (KEYWORD_HEADING.test(line) && !/\.$/.test(line)) return true
  if (/[.;:,]$/.test(line) && !/^[A-Z0-9 .,&'’-]+$/.test(line)) return false
  if (/^\(.*\)$/.test(line)) return false // "(in millions)"
  if (!/^[A-Z]/.test(line)) return false
  const words = line.split(/\s+/).filter(w => w.length > 3 && /^[a-z]/i.test(w))
  if (words.length === 0) return /^[A-Z0-9 .,&'’-]+$/.test(line)
  const capitalised = words.filter(w => /^[A-Z]/.test(w)).length
  return capitalised / words.length >= 0.6
}

function splitSections(text: string): Section[] {
  const sections: Section[] = []
  let heading = ''
  let body: string[] = []
  const flush = () => {
    if (!heading && body.length === 0) return
    sections.push({ heading, body: body.join('\n'), order: sections.length, priority: 0 })
  }
  for (const line of text.split('\n')) {
    if (isHeading(line) && body.length > 0) {
      flush()
      heading = line
      body = []
    } else if (isHeading(line) && body.length === 0 && heading) {
      // Consecutive heading lines ("AMAZON.COM, INC." / "Consolidated
      // Statements of Cash Flows") form one heading.
      heading = `${heading} — ${line}`
    } else if (isHeading(line) && !heading && sections.length === 0 && body.length === 0) {
      heading = line
    } else {
      body.push(line)
    }
  }
  flush()
  for (const s of sections) s.priority = s.order === 0 ? 0 : priorityOf(s.heading)
  return sections
}

function render(s: Section): string {
  return s.heading ? (s.body ? `${s.heading}\n${s.body}` : s.heading) : s.body
}

export interface PrioritisedText {
  text: string
  truncated: boolean
  /** Headings of the sections left out, in document order. */
  omitted: string[]
}

/**
 * Fit ``text`` into ``maxChars`` by whole sections, highest priority first,
 * re-emitted in document order with an ``[omitted: …]`` marker for each
 * section left out. A high-priority section too big for what's left is cut
 * at a line boundary rather than dropped.
 */
export function prioritiseSections(text: string, maxChars: number): PrioritisedText {
  if (text.length <= maxChars) return { text, truncated: false, omitted: [] }
  const sections = splitSections(text)
  const ranked = [...sections].sort((a, b) => a.priority - b.priority || a.order - b.order)
  const kept = new Map<number, string>()
  let used = 0
  for (const s of ranked) {
    if (s.priority >= 9) continue
    const full = render(s)
    // The headline section must leave room for guidance, segments and cash
    // flow, so it gets at most half the budget.
    const remaining = s.priority === 0 ? Math.floor(maxChars / 2) : maxChars - used
    if (full.length + 1 <= remaining) {
      kept.set(s.order, full)
      used += full.length + 1
    } else if (s.priority <= 2 && remaining > 400) {
      const lines = full.split('\n')
      const partial: string[] = []
      let size = 0
      for (const l of lines) {
        if (size + l.length + 1 > remaining - 40) break
        partial.push(l)
        size += l.length + 1
      }
      partial.push('[… section truncated]')
      const cut = partial.join('\n')
      kept.set(s.order, cut)
      used += cut.length + 1
    }
  }
  const out: string[] = []
  const omitted: string[] = []
  for (const s of sections) {
    const k = kept.get(s.order)
    if (k !== undefined) {
      out.push(k)
    } else {
      const name = s.heading || '(untitled section)'
      omitted.push(name)
      out.push(`[omitted: ${name}]`)
    }
  }
  return { text: out.join('\n'), truncated: true, omitted }
}
