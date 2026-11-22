/**
 * The one shape the chat gets for a research run, built from what the run
 * persisted. `agents_debate` and `research_get` both return it, so a run read
 * inline and the same run read later cannot disagree.
 */
import { excerptKeyPoints } from './excerpt'

export type RiskSpeaker = 'aggressive' | 'conservative' | 'neutral'

/** What a run left in the database, already narrowed to the parts a verdict uses. */
export interface PersistedRun {
  runId: string
  symbol: string
  status: string
  error: string | null
  finishedAt: Date | null
  decision: { rating: string; confidence: number | null; rationale: string } | null
  /** Set only when the valuation veto changed the rating the agents reached. */
  cap: { originalRating: string; reason: string } | null
  valuation: {
    fairValue: number | null
    currentPrice: number | null
    /** A fraction: 0.2 is 20%. */
    marginOfSafetyPct: number | null
    dataQuality: string
    currency: string | null
    discardedReason: string | null
  } | null
  valuationUnavailableReason: string | null
  debate: Record<'bull' | 'bear' | RiskSpeaker | 'researchManager', string | null>
}

export type ValuationSummary =
  | { status: 'valued'; fair_value: number; current_price: number | null; margin_of_safety_pct: number | null; data_quality: string; currency: string | null }
  | { status: 'discarded'; reason: string; current_price: number | null; data_quality: string; currency: string | null }
  | { status: 'unavailable'; reason: string }

interface RunIdentity {
  runId: string
  symbol: string
  status: string
  finishedAt: string | null
  age_days: number | null
  /** The run page, which holds every report and the full rationale. */
  run_url: string
  error?: string
}

export interface RunVerdict extends RunIdentity {
  rating: string
  rating_cap: { original_rating: string; reason: string } | null
  confidence: number | null
  confidence_measures: string
  confidence_missing_reason: string | null
  valuation: ValuationSummary
  bull_case: string | null
  bear_case: string | null
  risk_dissent: Array<{ speaker: RiskSpeaker; text: string }> | null
  /** Why a debate field is null or is an opening rather than its key points. */
  debate_note: string | null
  research_manager_view?: string
  rationale: string
  rationale_truncated: boolean
}

export interface RunWithoutVerdict extends RunIdentity {
  rating: null
  no_verdict_reason: string
}

export type RunVerdictResult = RunVerdict | RunWithoutVerdict

const DAY_MS = 86_400_000

const CASE_CHARS = 450
const DISSENT_CHARS = 500
const MANAGER_CHARS = 600
const RATIONALE_CHARS = 1500
const RATIONALE_LEAD_CHARS = 450

// Mirrors HORIZON_DAYS and _CORRECT_IF in apps/api/app/services/agents/confidence.py.
// The run does not persist what its score was judged against.
const CONFIDENCE_HORIZON_DAYS = 7
const CORRECT_IF: Record<string, string> = {
  'strong-buy': 'the stock beats SPY by more than 0.5 percentage points',
  'buy': 'the stock beats SPY by more than 0.5 percentage points',
  'hold': 'the stock finishes within 1 percentage point of SPY',
  'reduce': 'the stock trails SPY by more than 0.5 percentage points',
  'sell': 'the stock trails SPY by more than 0.5 percentage points',
}

// The risk personas lean one way each, so the dissent is whoever leaned
// against the call: the conservative voice on a buy, the aggressive on a sell.
const BOTH_SIDES: RiskSpeaker[] = ['aggressive', 'conservative']
const DISSENTERS: Record<string, RiskSpeaker[]> = {
  'strong-buy': ['conservative'],
  'buy': ['conservative'],
  'hold': BOTH_SIDES,
  'reduce': ['aggressive'],
  'sell': ['aggressive'],
}

const SPEAKER_PREFIX = /^(?:Bull|Bear|Aggressive|Conservative|Neutral|Risky|Safe) Analyst:\s*/gm

function spoken(text: string | null): string | null {
  const stripped = text?.replaceAll(SPEAKER_PREFIX, '').trim()
  return stripped || null
}

function identify(run: PersistedRun, nowMs: number): RunIdentity {
  const finished = run.finishedAt?.getTime() ?? Number.NaN
  return {
    runId: run.runId,
    symbol: run.symbol,
    status: run.status,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    age_days: Number.isNaN(finished) ? null : Math.max(0, Math.floor((nowMs - finished) / DAY_MS)),
    run_url: `/research/${encodeURIComponent(run.symbol)}?run=${encodeURIComponent(run.runId)}`,
    ...(run.error ? { error: run.error } : {}),
  }
}

function noVerdictReason(run: PersistedRun): string {
  if (run.status === 'running') return 'the run is still in progress'
  if (run.status === 'complete') return 'the run completed without a decision'
  return `run ${run.status}: ${run.error ?? 'no reason recorded'}`
}

function summariseValuation(run: PersistedRun): ValuationSummary {
  const v = run.valuation
  if (!v) return { status: 'unavailable', reason: run.valuationUnavailableReason ?? 'no valuation was recorded for this run' }
  if (v.fairValue !== null) {
    return {
      status: 'valued',
      fair_value: v.fairValue,
      current_price: v.currentPrice,
      margin_of_safety_pct: v.marginOfSafetyPct === null ? null : Math.round(v.marginOfSafetyPct * 1000) / 10,
      data_quality: v.dataQuality,
      currency: v.currency,
    }
  }
  if (v.discardedReason) {
    return { status: 'discarded', reason: v.discardedReason, current_price: v.currentPrice, data_quality: v.dataQuality, currency: v.currency }
  }
  return { status: 'unavailable', reason: `no fair value was computed (data quality: ${v.dataQuality})` }
}

function summariseDebate(run: PersistedRun, ratingDebated: string) {
  const missing: string[] = []
  const openings: string[] = []
  const bounded = (field: string, text: string | null, maxChars: number): string | null => {
    if (text === null) return null
    const excerpt = excerptKeyPoints(text, { maxChars })
    if (excerpt.mode === 'head') openings.push(field)
    return excerpt.text
  }

  const bull = spoken(run.debate.bull)
  const bear = spoken(run.debate.bear)
  if (bull === null) missing.push('bull_case')
  if (bear === null) missing.push('bear_case')

  const dissenters = (DISSENTERS[ratingDebated] ?? BOTH_SIDES)
    .map(speaker => ({ speaker, text: spoken(run.debate[speaker]) }))
    .filter((d): d is { speaker: RiskSpeaker; text: string } => d.text !== null)
  if (dissenters.length === 0) missing.push('risk_dissent')
  const dissentChars = Math.floor(DISSENT_CHARS / Math.max(1, dissenters.length))

  const result = {
    bull_case: bounded('bull_case', bull, CASE_CHARS),
    bear_case: bounded('bear_case', bear, CASE_CHARS),
    risk_dissent: dissenters.length === 0
      ? null
      : dissenters.map(d => ({ speaker: d.speaker, text: bounded(`risk_dissent (${d.speaker})`, d.text, dissentChars) ?? '' })),
  }

  const manager = bull === null && bear === null ? spoken(run.debate.researchManager) : null
  const notes: string[] = []
  if (missing.length) notes.push(`${missing.join(', ')} not recorded for this run`)
  if (manager !== null) notes.push('research_manager_view is the research manager weighing both sides, given in their place')
  if (openings.length) notes.push(`${openings.join(', ')} carried no figures to rank by, so each is the opening of the argument as written`)

  return {
    ...result,
    debate_note: notes.length ? notes.join('; ') : null,
    ...(manager !== null ? { research_manager_view: excerptKeyPoints(manager, { maxChars: MANAGER_CHARS, leadChars: 250 }).text } : {}),
  }
}

export function buildRunVerdict(run: PersistedRun, nowMs: number): RunVerdictResult {
  const identity = identify(run, nowMs)
  if (!run.decision) return { ...identity, rating: null, no_verdict_reason: noVerdictReason(run) }

  const { rating, confidence } = run.decision
  const rationale = excerptKeyPoints(run.decision.rationale, { maxChars: RATIONALE_CHARS, leadChars: RATIONALE_LEAD_CHARS })
  const correctIf = CORRECT_IF[rating] ?? 'the rating proves correct against SPY'
  return {
    ...identity,
    rating,
    rating_cap: run.cap ? { original_rating: run.cap.originalRating, reason: run.cap.reason } : null,
    confidence,
    confidence_measures: `probability (0-100) that over the ${CONFIDENCE_HORIZON_DAYS} trading days after the run ${correctIf}; a short-horizon forecast of this rating, not conviction in the long-term thesis`,
    confidence_missing_reason: confidence === null
      ? 'no score was stored: the confidence judge failed or returned no usable number'
      : null,
    valuation: summariseValuation(run),
    ...summariseDebate(run, run.cap?.originalRating ?? rating),
    rationale: rationale.text,
    rationale_truncated: rationale.mode !== 'full',
  }
}
