/**
 * Alpha Vantage client: earnings-call transcripts and the analyst estimate
 * history (EPS and revenue consensus per period, with 7/30/60/90-day-ago
 * values and revision counts).
 *
 * The free key allows 25 requests a day and 1 a second. Every live call goes
 * through `avCall`, which runs one at a time, spaces calls, and counts them
 * in a per-UTC-day counter in the Redis cache. At the cap, or after Alpha
 * Vantage answers with its limit notice (HTTP 200 with an `Information` or
 * `Note` key), the day is marked exhausted and no further call is made.
 * Answers are cached so a repeat question costs nothing.
 */

export const AV_SOURCE = 'Alpha Vantage (alphavantage.co)'
export const AV_DAILY_LIMIT = 25
export const PREPARED_TURN_CHARS = 6000
export const QA_TURN_CHARS = 1500

const ESTIMATES_TTL = 12 * 3600
const TRANSCRIPT_TTL = 30 * 86_400
const EMPTY_TRANSCRIPT_TTL = 6 * 3600
const QUOTA_TTL = 2 * 86_400

export interface AvQuota {
  date: string
  used: number
  limit: number
  remaining: number
  exhausted: boolean
  configured: boolean
}

export type AvUnavailableReason = 'no_key' | 'quota_exhausted' | 'rate_limited' | 'error' | 'empty' | 'bad_request'

export type AvResult<T> =
  | { status: 'ok'; data: T; cached: boolean; source: string; quota: AvQuota }
  | { status: 'unavailable'; reason: AvUnavailableReason; message: string; source: string; quota: AvQuota }

interface QuotaRecord { used: number; exhausted: boolean }

let minGapMs = 1500
let burstBackoffMs = 3000
let lastCallAt = 0
let chain: Promise<unknown> = Promise.resolve()

export function __setThrottleForTests(ms: number): void {
  minGapMs = ms
  burstBackoffMs = ms
  lastCallAt = 0
  chain = Promise.resolve()
}

const apiKey = () => process.env.ALPHA_VANTAGE_API_KEY?.trim() || ''
const utcDate = (now: Date) => now.toISOString().slice(0, 10)
const quotaKey = (date: string) => `alpha-vantage:quota:${date}`
const cache = () => useStorage('cache')
/** Alpha Vantage takes bare US tickers; drop moomoo's `US.` prefix. */
const avSymbol = (s: string) => s.trim().toUpperCase().replace(/^US\./, '')

async function readQuota(now: Date): Promise<QuotaRecord> {
  const rec = await cache().getItem<QuotaRecord>(quotaKey(utcDate(now))).catch(() => null)
  return { used: rec?.used ?? 0, exhausted: rec?.exhausted ?? false }
}

function toQuota(now: Date, rec: QuotaRecord): AvQuota {
  const remaining = rec.exhausted ? 0 : Math.max(0, AV_DAILY_LIMIT - rec.used)
  return {
    date: utcDate(now),
    used: rec.used,
    limit: AV_DAILY_LIMIT,
    remaining,
    exhausted: rec.exhausted || remaining === 0,
    configured: apiKey() !== '',
  }
}

export async function getAlphaVantageQuota(now: Date = new Date()): Promise<AvQuota> {
  return toQuota(now, await readQuota(now))
}

type CallOutcome =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'no_key' | 'quota_exhausted' | 'rate_limited' | 'error'; message: string }

/**
 * Alpha Vantage answers both limits with HTTP 200 and an `Information` (or
 * `Note`) string, and the per-second notice also mentions "25 requests per
 * day", so match the daily wording exactly: "rate limit is 25 requests per day".
 */
export function classifyNotice(notice: string): 'daily' | 'burst' | 'other' {
  if (/rate limit is \d+ requests per day/i.test(notice)) return 'daily'
  if (/per second|sparingly|burst/i.test(notice)) return 'burst'
  return 'other'
}

/** One live request, serialised and counted against today's allowance. */
function avCall(params: Record<string, string>, now: Date): Promise<CallOutcome> {
  const run = async (): Promise<CallOutcome> => {
    const key = apiKey()
    if (!key) return { kind: 'no_key', message: 'ALPHA_VANTAGE_API_KEY is not set.' }
    const rec = await readQuota(now)
    if (rec.exhausted || rec.used >= AV_DAILY_LIMIT) {
      return { kind: 'quota_exhausted', message: `Alpha Vantage daily limit (${AV_DAILY_LIMIT}) reached; resets at 00:00 UTC.` }
    }
    let used = rec.used
    const save = (next: QuotaRecord) =>
      cache().setItem(quotaKey(utcDate(now)), next, { ttl: QUOTA_TTL }).catch((err: unknown) => {
        console.warn('[alpha-vantage] quota write failed', err)
      })
    for (let attempt = 0; ; attempt++) {
      const wait = lastCallAt + (attempt ? burstBackoffMs : minGapMs) - Date.now()
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      lastCallAt = Date.now()
      // Count before the outcome is known: a throttled request may still count on their side.
      used += 1
      let body: unknown
      try {
        const { ofetch } = await import('ofetch')
        body = await ofetch('https://www.alphavantage.co/query', {
          query: { ...params, apikey: key },
          timeout: 20_000,
          retry: 0,
        })
      } catch (err) {
        await save({ used, exhausted: false })
        return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
      }
      const obj = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
      const notice = obj.Information ?? obj.Note
      if (typeof notice === 'string') {
        const kind = classifyNotice(notice)
        if (kind === 'daily') {
          // The provider's count is authoritative, so stop for the day.
          await save({ used: Math.max(used, AV_DAILY_LIMIT), exhausted: true })
          return { kind: 'quota_exhausted', message: notice }
        }
        if (kind === 'burst' && attempt === 0 && used < AV_DAILY_LIMIT) continue
        await save({ used, exhausted: false })
        return { kind: kind === 'burst' ? 'rate_limited' : 'error', message: notice }
      }
      await save({ used, exhausted: false })
      if (typeof obj['Error Message'] === 'string') return { kind: 'error', message: obj['Error Message'] as string }
      return { kind: 'ok', body: obj }
    }
  }
  const next = chain.then(run, run)
  chain = next.catch(() => undefined)
  return next
}

async function unavailable<T>(reason: AvUnavailableReason, message: string, now: Date): Promise<AvResult<T>> {
  return { status: 'unavailable', reason, message, source: AV_SOURCE, quota: await getAlphaVantageQuota(now) }
}

/** Cached-or-live fetch of one Alpha Vantage document. */
async function fetchDoc(
  cacheKey: string,
  params: Record<string, string>,
  ttlFor: (body: Record<string, unknown>) => number,
  now: Date,
): Promise<{ body: Record<string, unknown>; cached: boolean } | { fail: AvUnavailableReason; message: string }> {
  const hit = await cache().getItem<Record<string, unknown>>(cacheKey).catch(() => null)
  if (hit) return { body: hit, cached: true }
  const out = await avCall(params, now)
  if (out.kind !== 'ok') return { fail: out.kind, message: out.message }
  await cache().setItem(cacheKey, out.body, { ttl: ttlFor(out.body) }).catch((err: unknown) => {
    console.warn('[alpha-vantage] cache write failed', cacheKey, err)
  })
  return { body: out.body, cached: false }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || v === 'None') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ─── estimates ────────────────────────────────────────────────────────

export interface EstimatePeriod {
  date: string
  horizon: 'quarter' | 'year'
  eps_avg: number | null
  eps_low: number | null
  eps_high: number | null
  eps_analysts: number | null
  eps_7d_ago: number | null
  eps_30d_ago: number | null
  eps_90d_ago: number | null
  /** % change of the EPS consensus over the last 90 days. */
  eps_change_90d_pct: number | null
  revisions_7d: { up: number | null; down: number | null }
  revisions_30d: { up: number | null; down: number | null }
  revenue_avg: number | null
  revenue_low: number | null
  revenue_high: number | null
  revenue_analysts: number | null
}

export interface EstimateRevisions {
  symbol: string
  /** Upcoming periods, nearest first. */
  forward: EstimatePeriod[]
  /** The last four quarters whose period has ended, newest first: the consensus going into each print. */
  reported: EstimatePeriod[]
}

function toPeriod(r: Record<string, unknown>): EstimatePeriod {
  const eps = num(r.eps_estimate_average)
  const eps90 = num(r.eps_estimate_average_90_days_ago)
  return {
    date: String(r.date ?? ''),
    horizon: String(r.horizon ?? '').includes('year') ? 'year' : 'quarter',
    eps_avg: eps,
    eps_low: num(r.eps_estimate_low),
    eps_high: num(r.eps_estimate_high),
    eps_analysts: num(r.eps_estimate_analyst_count),
    eps_7d_ago: num(r.eps_estimate_average_7_days_ago),
    eps_30d_ago: num(r.eps_estimate_average_30_days_ago),
    eps_90d_ago: eps90,
    eps_change_90d_pct: eps !== null && eps90 !== null && eps90 !== 0 ? ((eps - eps90) / Math.abs(eps90)) * 100 : null,
    revisions_7d: { up: num(r.eps_estimate_revision_up_trailing_7_days), down: num(r.eps_estimate_revision_down_trailing_7_days) },
    revisions_30d: { up: num(r.eps_estimate_revision_up_trailing_30_days), down: num(r.eps_estimate_revision_down_trailing_30_days) },
    revenue_avg: num(r.revenue_estimate_average),
    revenue_low: num(r.revenue_estimate_low),
    revenue_high: num(r.revenue_estimate_high),
    revenue_analysts: num(r.revenue_estimate_analyst_count),
  }
}

export async function getEstimateRevisions(symbol: string, now: Date = new Date()): Promise<AvResult<EstimateRevisions>> {
  const sym = avSymbol(symbol)
  const doc = await fetchDoc(`alpha-vantage:estimates:${sym}`, { function: 'EARNINGS_ESTIMATES', symbol: sym }, () => ESTIMATES_TTL, now)
  if ('fail' in doc) return unavailable(doc.fail, doc.message, now)
  const rows = Array.isArray(doc.body.estimates) ? doc.body.estimates : []
  const periods = rows
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map(toPeriod)
    .filter(p => /^\d{4}-\d{2}-\d{2}$/.test(p.date))
  if (!periods.length) return unavailable('empty', `Alpha Vantage has no estimates for ${sym}.`, now)
  const today = utcDate(now)
  const forward = periods
    .filter(p => p.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.horizon === 'quarter' ? -1 : 1))
  const reported = periods
    .filter(p => p.date < today && p.horizon === 'quarter')
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 4)
  return {
    status: 'ok',
    data: { symbol: sym, forward, reported },
    cached: doc.cached,
    source: `${AV_SOURCE} EARNINGS_ESTIMATES`,
    quota: await getAlphaVantageQuota(now),
  }
}

// ─── transcripts ──────────────────────────────────────────────────────

export interface TranscriptTurn {
  speaker: string
  title: string
  /** Alpha Vantage's sentiment score for the turn, roughly −1..1. */
  sentiment: number | null
  content: string
  truncated: boolean
}

export interface EarningsCallTranscript {
  symbol: string
  quarter: string
  prepared: TranscriptTurn[]
  qa: TranscriptTurn[]
  total_chars: number
  notes: string[]
}

const QUARTER_RE = /^\d{4}Q[1-4]$/

/** The most recent calendar quarter that has ended, then the one before it. */
export function recentQuarters(now: Date): [string, string] {
  const y = now.getUTCFullYear()
  const q = Math.floor(now.getUTCMonth() / 3) // current quarter index 0..3
  const last = q === 0 ? { y: y - 1, q: 4 } : { y, q }
  const prev = last.q === 1 ? { y: last.y - 1, q: 4 } : { y: last.y, q: last.q - 1 }
  return [`${last.y}Q${last.q}`, `${prev.y}Q${prev.q}`]
}

const cap = (s: string, n: number) => (s.length > n ? { text: `${s.slice(0, n)}…`, cut: true } : { text: s, cut: false })

function shapeTranscript(sym: string, quarter: string, raw: unknown[]): EarningsCallTranscript {
  const turns = raw.filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
  // Q&A starts at the first operator turn that mentions questions after someone else has spoken.
  const qaStart = turns.findIndex((t, i) =>
    i > 0 && /operator/i.test(String(t.title ?? t.speaker ?? '')) && /question/i.test(String(t.content ?? '')))
  const split = qaStart === -1 ? turns.length : qaStart
  const shape = (t: Record<string, unknown>, limit: number): TranscriptTurn => {
    const { text, cut } = cap(String(t.content ?? ''), limit)
    return {
      speaker: String(t.speaker ?? ''),
      title: String(t.title ?? ''),
      sentiment: num(t.sentiment),
      content: text,
      truncated: cut,
    }
  }
  return {
    symbol: sym,
    quarter,
    prepared: turns.slice(0, split).map(t => shape(t, PREPARED_TURN_CHARS)),
    qa: turns.slice(split).map(t => shape(t, QA_TURN_CHARS)),
    total_chars: turns.reduce((n, t) => n + String(t.content ?? '').length, 0),
    notes: [],
  }
}

export async function getEarningsCallTranscript(
  symbol: string,
  quarter?: string,
  now: Date = new Date(),
): Promise<AvResult<EarningsCallTranscript>> {
  const sym = avSymbol(symbol)
  const wanted = quarter?.trim().toUpperCase()
  if (wanted && !QUARTER_RE.test(wanted)) {
    return unavailable('bad_request', `quarter must look like 2026Q3, got "${quarter}".`, now)
  }
  const candidates = wanted ? [wanted] : recentQuarters(now)
  const notes: string[] = []
  for (const q of candidates) {
    const doc = await fetchDoc(
      `alpha-vantage:transcript:${sym}:${q}`,
      { function: 'EARNINGS_CALL_TRANSCRIPT', symbol: sym, quarter: q },
      body => (Array.isArray(body.transcript) && body.transcript.length ? TRANSCRIPT_TTL : EMPTY_TRANSCRIPT_TTL),
      now,
    )
    if ('fail' in doc) return unavailable(doc.fail, doc.message, now)
    const raw = Array.isArray(doc.body.transcript) ? doc.body.transcript : []
    if (!raw.length) {
      notes.push(`No ${q} transcript published yet.`)
      continue
    }
    const data = shapeTranscript(sym, q, raw)
    data.notes = notes
    return { status: 'ok', data, cached: doc.cached, source: `${AV_SOURCE} EARNINGS_CALL_TRANSCRIPT`, quota: await getAlphaVantageQuota(now) }
  }
  return unavailable('empty', `No earnings-call transcript for ${sym} (${candidates.join(', ')}). ${notes.join(' ')}`.trim(), now)
}
