import { beforeEach, describe, expect, it, vi } from 'vitest'

const ofetch = vi.fn()
vi.mock('ofetch', () => ({ ofetch: (...args: unknown[]) => ofetch(...args) }))
const quoteSummary = vi.fn()
vi.mock('../../server/lib/yahoo', () => ({ yahooClient: { quoteSummary: (...args: unknown[]) => quoteSummary(...args) } }))
const fiscalYearEnd = (iso: string) => ({ defaultKeyStatistics: { nextFiscalYearEnd: new Date(iso) } })

type Av = typeof import('../../server/lib/alpha-vantage')
let av: Av
let store: Map<string, unknown>
let ttls: Map<string, number | undefined>

beforeEach(async () => {
  vi.resetModules()
  ofetch.mockReset()
  quoteSummary.mockReset()
  quoteSummary.mockResolvedValue(fiscalYearEnd('2026-12-31T00:00:00Z'))
  vi.stubEnv('ALPHA_VANTAGE_API_KEY', 'test-key')
  store = new Map()
  ttls = new Map()
  vi.stubGlobal('useStorage', () => ({
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: unknown, opts?: { ttl?: number }) => {
      store.set(k, v)
      ttls.set(k, opts?.ttl)
    },
  }))
  av = await import('../../server/lib/alpha-vantage')
  av.__setThrottleForTests(0)
})

const NOW = new Date('2026-10-31T09:00:00Z')

const TRANSCRIPT = {
  symbol: 'AMZN',
  quarter: '2026Q2',
  transcript: [
    { speaker: 'Operator', title: 'Operator', content: 'Welcome to the call.', sentiment: '0.0' },
    { speaker: 'Andy Jassy', title: 'Chief Executive Officer', content: 'AWS grew 39%. '.repeat(500), sentiment: '0.9' },
    { speaker: 'Operator', title: 'Operator', content: 'We will now open the call up for questions.', sentiment: '0.0' },
    { speaker: 'Doug Anmuth', title: 'Analyst, J.P. Morgan', content: 'How durable is the AWS acceleration?', sentiment: '0.0' },
    { speaker: 'Brian Olsavsky', title: 'Chief Financial Officer', content: 'Capacity is the constraint.', sentiment: '0.5' },
  ],
}

const row = (date: string, horizon: string, eps: string, eps90: string, rev: string) => ({
  date,
  horizon,
  eps_estimate_average: eps,
  eps_estimate_high: null,
  eps_estimate_low: null,
  eps_estimate_analyst_count: '40.0000',
  eps_estimate_average_7_days_ago: eps,
  eps_estimate_average_30_days_ago: eps,
  eps_estimate_average_60_days_ago: eps,
  eps_estimate_average_90_days_ago: eps90,
  eps_estimate_revision_up_trailing_7_days: '1.0000',
  eps_estimate_revision_down_trailing_7_days: null,
  eps_estimate_revision_up_trailing_30_days: '4.0000',
  eps_estimate_revision_down_trailing_30_days: '1.0000',
  revenue_estimate_average: rev,
  revenue_estimate_high: null,
  revenue_estimate_low: null,
  revenue_estimate_analyst_count: '47.00',
})

const ESTIMATES = {
  symbol: 'AMZN',
  estimates: [
    row('2027-12-31', 'fiscal year', '10.5527', '10.0790', '949994167900.00'),
    row('2026-12-31', 'fiscal year', '12.9220', '8.7887', '828640683860.00'),
    row('2026-12-31', 'fiscal quarter', '2.4559', '2.3989', '244309143060.00'),
    row('2026-09-30', 'fiscal quarter', '1.9594', '1.9180', '202264872830.00'),
    row('2026-06-30', 'fiscal quarter', '1.8227', '1.7676', '196433361480.00'),
    row('2026-03-31', 'fiscal quarter', '1.6530', '1.7193', '177169233990.00'),
    row('2025-12-31', 'fiscal quarter', '1.9596', '1.9351', '211233281540.00'),
    row('2025-09-30', 'fiscal quarter', '1.5576', '1.5218', '177760648620.00'),
  ],
}

const RATE_LIMIT = {
  Information: 'We have detected your API key as test-key and our standard API rate limit is 25 requests per day.',
}

const BURST = {
  Information: 'Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit (25 requests per day), raise the per-second burst limit, and instantly unlock all premium endpoints',
}

function calls(fn: string): number {
  return ofetch.mock.calls.filter(([, o]) => (o as { query: { function: string } }).query.function === fn).length
}

describe('quota', () => {
  it('starts the day with the full free-tier allowance', async () => {
    expect(await av.getAlphaVantageQuota(NOW)).toEqual({
      date: '2026-10-31', used: 0, limit: 25, remaining: 25, exhausted: false, configured: true,
    })
  })

  it('counts each live call and keeps the counter for a day', async () => {
    ofetch.mockResolvedValue(ESTIMATES)
    const r = await av.getEstimateRevisions('AMZN', NOW)
    expect(r.quota.used).toBe(1)
    expect(r.quota.remaining).toBe(24)
    expect(ttls.get('alpha-vantage:quota:2026-10-31')).toBeGreaterThanOrEqual(86_400)
  })

  it('serves a cached answer without spending quota', async () => {
    ofetch.mockResolvedValue(ESTIMATES)
    await av.getEstimateRevisions('AMZN', NOW)
    const second = await av.getEstimateRevisions('amzn', NOW)
    expect(ofetch).toHaveBeenCalledTimes(1)
    expect(second.status).toBe('ok')
    expect(second.cached).toBe(true)
    expect(second.quota.used).toBe(1)
  })

  it('refuses to call once the daily cap is reached', async () => {
    store.set('alpha-vantage:quota:2026-10-31', { used: 25, exhausted: false })
    const r = await av.getEstimateRevisions('AMZN', NOW)
    expect(ofetch).not.toHaveBeenCalled()
    expect(r).toMatchObject({ status: 'unavailable', reason: 'quota_exhausted' })
    expect(r.quota.remaining).toBe(0)
  })

  it('marks the day exhausted when Alpha Vantage answers with a limit notice', async () => {
    ofetch.mockResolvedValue(RATE_LIMIT)
    const r = await av.getEstimateRevisions('AMZN', NOW)
    expect(r).toMatchObject({ status: 'unavailable', reason: 'quota_exhausted' })
    expect(r.quota).toMatchObject({ exhausted: true, remaining: 0 })
    ofetch.mockClear()
    await av.getEstimateRevisions('MSFT', NOW)
    expect(ofetch).not.toHaveBeenCalled()
  })

  it('retries a per-second burst notice once instead of ending the day', async () => {
    ofetch.mockResolvedValueOnce(BURST).mockResolvedValueOnce(ESTIMATES)
    const r = await av.getEstimateRevisions('AMZN', NOW)
    expect(r.status).toBe('ok')
    expect(ofetch).toHaveBeenCalledTimes(2)
    expect(r.quota).toMatchObject({ used: 2, exhausted: false })
  })

  it('a second burst notice in a row fails the call but leaves the day open', async () => {
    ofetch.mockResolvedValue(BURST)
    const r = await av.getEstimateRevisions('AMZN', NOW)
    expect(r).toMatchObject({ status: 'unavailable', reason: 'rate_limited' })
    expect(r.quota).toMatchObject({ used: 2, exhausted: false, remaining: 23 })
  })

  it('does not cache a limit notice as data', async () => {
    ofetch.mockResolvedValueOnce(RATE_LIMIT)
    await av.getEstimateRevisions('AMZN', NOW)
    const tomorrow = new Date('2026-11-01T09:00:00Z')
    ofetch.mockResolvedValueOnce(ESTIMATES)
    const r = await av.getEstimateRevisions('AMZN', tomorrow)
    expect(r.status).toBe('ok')
    expect(r.quota).toMatchObject({ date: '2026-11-01', used: 1 })
  })

  it('reports not configured without a key and makes no call', async () => {
    vi.stubEnv('ALPHA_VANTAGE_API_KEY', '')
    const r = await av.getEstimateRevisions('AMZN', NOW)
    expect(r).toMatchObject({ status: 'unavailable', reason: 'no_key' })
    expect(r.quota.configured).toBe(false)
    expect(ofetch).not.toHaveBeenCalled()
  })

  it('surfaces a network failure as unavailable, still counting the call', async () => {
    ofetch.mockRejectedValue(new Error('ECONNRESET'))
    const r = await av.getEstimateRevisions('AMZN', NOW)
    expect(r).toMatchObject({ status: 'unavailable', reason: 'error' })
    expect(r.quota.used).toBe(1)
  })

  it('never sends the key anywhere but the query string of alphavantage.co', async () => {
    ofetch.mockResolvedValue(ESTIMATES)
    await av.getEstimateRevisions('AMZN', NOW)
    const [url, opts] = ofetch.mock.calls[0] as [string, { query: Record<string, string> }]
    expect(url).toBe('https://www.alphavantage.co/query')
    expect(opts.query).toMatchObject({ function: 'EARNINGS_ESTIMATES', symbol: 'AMZN', apikey: 'test-key' })
  })
})

describe('getEstimateRevisions', () => {
  it('spends one request when two analysts ask for the same cold symbol at once', async () => {
    ofetch.mockResolvedValue(ESTIMATES)
    const [a, b] = await Promise.all([av.getEstimateRevisions('AMZN', NOW), av.getEstimateRevisions('US.AMZN', NOW)])
    expect(a.status).toBe('ok')
    expect(b.status).toBe('ok')
    expect(calls('EARNINGS_ESTIMATES')).toBe(1)
    expect((await av.getAlphaVantageQuota(NOW)).used).toBe(1)
  })

  it('keeps forward periods and the last four reported quarters, as numbers', async () => {
    ofetch.mockResolvedValue(ESTIMATES)
    const r = await av.getEstimateRevisions('AMZN', NOW)
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.data.forward.map(p => `${p.horizon}:${p.date}`)).toEqual([
      'quarter:2026-12-31', 'year:2026-12-31', 'year:2027-12-31',
    ])
    expect(r.data.reported.map(p => p.date)).toEqual(['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31'])
    const fy = r.data.forward[1]!
    expect(fy.eps_avg).toBeCloseTo(12.922)
    expect(fy.eps_90d_ago).toBeCloseTo(8.7887)
    expect(fy.eps_change_90d_pct).toBeCloseTo(47.03, 1)
    expect(fy.revisions_30d).toEqual({ up: 4, down: 1 })
    expect(r.data.reported[0]!.revenue_avg).toBe(202264872830)
    expect(r.source).toContain('Alpha Vantage')
  })
})

describe('recentQuarters', () => {
  // Alpha Vantage keys transcripts by FISCAL quarter, named for the year the fiscal year ends in.
  it.each([
    [12, ['2026Q3', '2026Q2']], // AMZN: calendar year
    [9, ['2026Q4', '2026Q3']], // AAPL: the July-September quarter closes fiscal 2026
    [6, ['2027Q1', '2026Q4']], // MSFT: fiscal 2027 began in July
    [1, ['2027Q2', '2027Q1']], // WMT: May-July is Q2 of the year ending January 2027; Q3 ends tonight
  ])('fiscal year ending in month %i', (month, expected) => {
    expect(av.recentQuarters(NOW, month)).toEqual(expected)
  })
})

describe('fiscalYearEndMonth', () => {
  it('reads the month from Yahoo and treats a 52/53-week year ending in the first days of a month as the month before', async () => {
    quoteSummary.mockResolvedValueOnce(fiscalYearEnd('2026-09-27T00:00:00Z'))
    expect(await av.fiscalYearEndMonth('US.AAPL')).toBe(9)
    quoteSummary.mockResolvedValueOnce(fiscalYearEnd('2027-01-02T00:00:00Z'))
    expect(await av.fiscalYearEndMonth('US.XYZ')).toBe(12)
  })

  it('falls back to December when Yahoo fails, and caches a real answer', async () => {
    quoteSummary.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    expect(await av.fiscalYearEndMonth('US.MSFT')).toBe(12)
    quoteSummary.mockResolvedValueOnce(fiscalYearEnd('2027-06-30T00:00:00Z'))
    expect(await av.fiscalYearEndMonth('US.MSFT')).toBe(6)
    expect(await av.fiscalYearEndMonth('US.MSFT')).toBe(6)
    expect(quoteSummary).toHaveBeenCalledTimes(2)
  })
})

describe('getEarningsCallTranscript', () => {
  it('asks for the fiscal quarter, not the calendar one', async () => {
    quoteSummary.mockResolvedValue(fiscalYearEnd('2026-09-27T00:00:00Z'))
    ofetch.mockResolvedValue({ ...TRANSCRIPT, symbol: 'AAPL', quarter: '2026Q4' })
    const r = await av.getEarningsCallTranscript('AAPL', undefined, NOW)
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.data.quarter).toBe('2026Q4')
    expect(ofetch.mock.calls[0]![1]).toMatchObject({ query: { quarter: '2026Q4' } })
  })

  it('does not look up the fiscal year when the quarter is given', async () => {
    ofetch.mockResolvedValue(TRANSCRIPT)
    await av.getEarningsCallTranscript('AMZN', '2026Q2', NOW)
    expect(quoteSummary).not.toHaveBeenCalled()
  })

  it('defaults to the latest fiscal quarter and falls back one when it is not published yet', async () => {
    ofetch.mockImplementation(async (_u: string, o: { query: { quarter: string } }) =>
      o.query.quarter === '2026Q3' ? { symbol: 'AMZN', quarter: '2026Q3', transcript: [] } : TRANSCRIPT)
    const r = await av.getEarningsCallTranscript('AMZN', undefined, NOW)
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.data.quarter).toBe('2026Q2')
    expect(r.data.notes.join(' ')).toContain('2026Q3')
    expect(calls('EARNINGS_CALL_TRANSCRIPT')).toBe(2)
  })

  it('caches an empty transcript briefly and a published one for a month', async () => {
    ofetch.mockImplementation(async (_u: string, o: { query: { quarter: string } }) =>
      o.query.quarter === '2026Q3' ? { symbol: 'AMZN', quarter: '2026Q3', transcript: [] } : TRANSCRIPT)
    await av.getEarningsCallTranscript('AMZN', undefined, NOW)
    expect(ttls.get('alpha-vantage:transcript:AMZN:2026Q3')).toBe(6 * 3600)
    expect(ttls.get('alpha-vantage:transcript:AMZN:2026Q2')).toBe(30 * 86_400)
    ofetch.mockClear()
    await av.getEarningsCallTranscript('AMZN', undefined, NOW)
    expect(ofetch).not.toHaveBeenCalled()
  })

  it('splits prepared remarks from Q&A and caps long turns', async () => {
    ofetch.mockResolvedValue(TRANSCRIPT)
    const r = await av.getEarningsCallTranscript('AMZN', '2026Q2', NOW)
    if (r.status !== 'ok') throw new Error('expected ok')
    expect(r.data.prepared.map(t => t.speaker)).toEqual(['Operator', 'Andy Jassy'])
    expect(r.data.qa.map(t => t.speaker)).toEqual(['Operator', 'Doug Anmuth', 'Brian Olsavsky'])
    expect(r.data.prepared[1]!.sentiment).toBeCloseTo(0.9)
    expect(r.data.prepared[1]!.content.length).toBeLessThanOrEqual(av.PREPARED_TURN_CHARS + 1)
    expect(r.data.prepared[1]!.truncated).toBe(true)
    expect(r.data.total_chars).toBe(TRANSCRIPT.transcript.reduce((n, t) => n + t.content.length, 0))
  })

  it('rejects a malformed quarter before spending quota', async () => {
    const r = await av.getEarningsCallTranscript('AMZN', 'Q3 2026', NOW)
    expect(r).toMatchObject({ status: 'unavailable', reason: 'bad_request' })
    expect(ofetch).not.toHaveBeenCalled()
  })

  it('says so when neither quarter has a transcript', async () => {
    ofetch.mockResolvedValue({ symbol: 'AMZN', quarter: 'x', transcript: [] })
    const r = await av.getEarningsCallTranscript('AMZN', undefined, NOW)
    expect(r).toMatchObject({ status: 'unavailable', reason: 'empty' })
  })
})
