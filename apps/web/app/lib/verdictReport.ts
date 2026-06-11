// Parser for the risk-manager's free-text ``final_trade_decision`` so the
// verdict card can render it as a structured research report rather than one
// undifferentiated wall of markdown.
//
// The model writes the report as a sequence of titled sections — sometimes as
// markdown headings (``## Summary of Key Arguments``), sometimes as a bold
// line (``**Summary of Key Arguments**``), sometimes as a numbered heading
// (``1. Summary of Key Arguments``). We detect all three and split the body
// accordingly. When no headings are found we return a single untitled section
// so the card degrades gracefully to plain rendered markdown.

export interface VerdictReportSection {
  /** Section heading, or null for content before the first heading. */
  title: string | null
  /** Markdown body for this section (heading line excluded). */
  body: string
}

// The canonical machine marker is redundant with the rating chip the card
// already shows in large type — strip it so the report doesn't repeat the
// verdict in fine print.
const CANONICAL_MARKER = /^\s*\**\s*final\s+transaction\s+proposal\s*:.*$/i

const ATX_HEADING = /^\s*#{1,6}\s+(.+?)\s*$/
const BOLD_ONLY = /^\s*\*\*(.+?)\*\*:?\s*$/
const NUMBERED = /^\s*\d+[.)]\s+(.+?)\s*$/

/** A numbered line is a section heading only when it reads like a title:
 *  short, and not a full sentence (no terminal sentence punctuation). This
 *  keeps ordered-list items ("1. Buy 100 shares.") out of the heading set. */
function numberedHeadingTitle(line: string): string | null {
  const m = line.match(NUMBERED)
  if (!m?.[1]) return null
  const raw = m[1].replace(/^\*\*(.+?)\*\*$/, '$1').replace(/:$/, '').trim()
  if (raw.length === 0 || raw.length > 60) return null
  if (/[.!?]$/.test(raw)) return null
  return raw
}

function headingTitle(line: string): string | null {
  const atx = line.match(ATX_HEADING)
  if (atx?.[1]) return atx[1].replace(/:$/, '').trim()
  const bold = line.match(BOLD_ONLY)
  if (bold?.[1]) return bold[1].replace(/:$/, '').trim()
  return numberedHeadingTitle(line)
}

export function parseVerdictReport(markdown: string): VerdictReportSection[] {
  const lines = (markdown || '').split('\n').filter(l => !CANONICAL_MARKER.test(l))

  const sections: VerdictReportSection[] = []
  let current: VerdictReportSection = { title: null, body: '' }
  const bodyLines: string[] = []

  const flush = () => {
    current.body = bodyLines.join('\n').trim()
    if (current.title !== null || current.body.length > 0) sections.push(current)
    bodyLines.length = 0
  }

  for (const line of lines) {
    const title = headingTitle(line)
    if (title !== null) {
      flush()
      current = { title, body: '' }
    } else {
      bodyLines.push(line)
    }
  }
  flush()

  // Degrade gracefully: no detected structure -> one untitled section so the
  // caller can still render the full markdown in a single block.
  if (sections.length === 0) return [{ title: null, body: (markdown || '').trim() }]
  return sections
}
