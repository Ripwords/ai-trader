export type Rating = 'strong-buy' | 'buy' | 'hold' | 'reduce' | 'sell'
export type OwnerVerdict = 'add' | 'hold' | 'trim' | 'do-not-add'

export const OWNER_VERDICT_LABEL: Record<OwnerVerdict, string> = {
  'add': 'Add',
  'hold': 'Hold',
  'trim': 'Trim',
  'do-not-add': 'Do not add',
}

export function isOwnerVerdict(v: unknown): v is OwnerVerdict {
  return typeof v === 'string' && Object.hasOwn(OWNER_VERDICT_LABEL, v)
}

// Mirrors HORIZON_DAYS and _CORRECT_IF in apps/api/app/services/agents/confidence.py.
// The run does not persist what its score was judged against.
export const CONFIDENCE_HORIZON_DAYS = 7
const CORRECT_IF: Record<Rating, string> = {
  'strong-buy': 'the stock beats SPY by more than 0.5 percentage points',
  'buy': 'the stock beats SPY by more than 0.5 percentage points',
  'hold': 'the stock finishes within 1 percentage point of SPY',
  'reduce': 'the stock trails SPY by more than 0.5 percentage points',
  'sell': 'the stock trails SPY by more than 0.5 percentage points',
}

/** What has to happen for a rating's confidence score to count as right. */
export function confidenceCorrectIf(rating: string): string {
  return Object.hasOwn(CORRECT_IF, rating) ? CORRECT_IF[rating as Rating] : 'the rating proves correct against SPY'
}

/** The confidence score in words, for beside the percentage. */
export function confidenceLabel(rating: string, confidence: number): string {
  return `${confidence}% chance ${confidenceCorrectIf(rating)} over ${CONFIDENCE_HORIZON_DAYS} trading days`
}

const SPEAKER_PREFIX = /^(?:Bull|Bear|Aggressive|Conservative|Neutral|Risky|Safe) Analyst:\s*/gm

/** A debate turn as the speaker wrote it, without the "Bull Analyst:" the api puts in front. */
export function withoutSpeakerPrefix(text: string): string {
  return text.replaceAll(SPEAKER_PREFIX, '')
}

export type RunStatus = 'running' | 'complete' | 'failed' | 'cancelled'

/** Tags for the four analyst reports. Match graph._REPORT_KIND_MAP. */
export type ReportKind = 'market' | 'sentiment' | 'news' | 'fundamentals'

/** Risk debate seats — three voices instead of bull/bear. */
export type RiskSpeaker = 'aggressive' | 'conservative' | 'neutral'

/** Synthesis stage tags. ``judge-decision`` is the Research Manager's
 *  closing argument on the bull/bear debate; ``investment-plan`` is the
 *  same RM's synthesised plan; ``trader-plan`` is the Trader's expanded
 *  execution plan. All three sit between debate and verdict in the
 *  pipeline. */
export type SynthesisStage = 'judge-decision' | 'investment-plan' | 'trader-plan'

export type AgentEvent =
  | { type: 'run-start'; run_id: string; symbol: string; config: Record<string, unknown> }
  | { type: 'node-start'; node: string }
  | { type: 'tool-call'; node: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool-result'; node: string; tool: string; ok: boolean; preview: string }
  | { type: 'node-message'; node: string; delta: string }
  | { type: 'node-end'; node: string; summary: string }
  | { type: 'debate-round'; round: number; side: 'bull' | 'bear'; text: string }
  | { type: 'risk-debate-turn'; speaker: RiskSpeaker; text: string; turn: number }
  | { type: 'report'; kind: ReportKind; node: string; content: string }
  | { type: 'synthesis'; stage: SynthesisStage; node: string; content: string }
  // `owner_verdict` is present when the run had an owner mandate to answer;
  // `rating` then follows it (add: buy, hold and do-not-add: hold, trim: reduce).
  | { type: 'decision'; rating: Rating; confidence: number | null; rationale: string; owner_verdict?: OwnerVerdict }
  // Sent once before the first debate turn (again on a resume). `reason` says
  // why there is no DCF fair value; it is null when status is 'ok'.
  | { type: 'valuation'; status: 'ok' | 'multiples_only' | 'unavailable'; reason: string | null }
  | { type: 'valuation-veto'; original_rating: string; effective_rating: string; reason: string; rating_cap: string }
  | { type: 'final-state'; state: Record<string, unknown> }
  | { type: 'run-end'; run_id: string; tokens_in: number; tokens_out: number; cost_usd: number }
  | { type: 'error'; node?: string; message: string }
  // Transport keepalive from the api; never persisted or rendered.
  | { type: 'heartbeat' }
