export interface DebateCardVerdict {
  rating: string
  cappedFrom: string | null
  capReason: string | null
  confidence: number | null
  rationale: string
  rationaleTruncated: boolean
  bullCase: string | null
  bearCase: string | null
  runUrl: string | null
}

export interface DebateCardView { steps: string[]; verdict: DebateCardVerdict | null; error: string | null }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/**
 * What the debate card shows for one `agents_debate` tool output. A saved chat
 * can hold any output ever written: progress yields, today's verdict, or the
 * older { events, rating, confidence, rationale }, so every field is read as
 * optional.
 */
export function debateCardView(output: unknown): DebateCardView {
  if (!isRecord(output)) return { steps: [], verdict: null, error: null }
  const events = Array.isArray(output.events) ? output.events : []
  const cap = isRecord(output.rating_cap) ? output.rating_cap : {}
  const rating = text(output.rating)
  return {
    steps: events.flatMap((e) => {
      const node = isRecord(e) && e.type === 'node-start' ? text(e.node) : null
      return node ? [node] : []
    }),
    error: text(output.error),
    verdict: rating
      ? {
          rating,
          cappedFrom: text(cap.original_rating),
          capReason: text(cap.reason),
          confidence: typeof output.confidence === 'number' ? output.confidence : null,
          rationale: text(output.rationale) ?? '',
          rationaleTruncated: output.rationale_truncated === true,
          bullCase: text(output.bull_case),
          bearCase: text(output.bear_case),
          runUrl: text(output.run_url),
        }
      : null,
  }
}
