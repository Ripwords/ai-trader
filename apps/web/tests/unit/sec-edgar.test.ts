import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubNitroCache } from '../fixtures/nitro-cache'

const ofetch = vi.fn()
vi.mock('ofetch', () => ({ ofetch: (...args: unknown[]) => ofetch(...args) }))

type Sec = typeof import('../../server/lib/sec-edgar')
let sec: Sec

beforeEach(async () => {
  vi.resetModules()
  ofetch.mockReset()
  vi.stubEnv('SEC_USER_AGENT', '')
  stubNitroCache()
  sec = await import('../../server/lib/sec-edgar')
  sec.__setThrottleForTests(0)
})

const TICKERS = {
  0: { cik_str: 1018724, ticker: 'AMZN', title: 'AMAZON COM INC' },
  1: { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
}

const SUBMISSIONS = {
  name: 'AMAZON COM INC',
  filings: {
    recent: {
      accessionNumber: ['0001018724-26-000040', '0001018724-26-000038', '0001018724-26-000020'],
      form: ['10-Q', '8-K', '8-K'],
      filingDate: ['2026-10-30', '2026-10-29', '2026-07-30'],
      reportDate: ['2026-09-30', '2026-10-29', '2026-07-30'],
      items: ['', '2.02,9.01', '2.02,9.01'],
      primaryDocument: ['amzn-20260930.htm', 'amzn-20261029.htm', 'amzn-20260730.htm'],
    },
  },
}

const INDEX_HTML = `<table class="tableFile">
<tr><td scope="row">1</td><td scope="row">8-K</td><td><a href="/Archives/edgar/data/1018724/000101872426000038/amzn-20261029.htm">amzn-20261029.htm</a></td><td scope="row">8-K</td></tr>
<tr><td scope="row">2</td><td scope="row">EX-99.1</td><td><a href="/Archives/edgar/data/1018724/000101872426000038/amzn-20260930xex991.htm">amzn-20260930xex991.htm</a></td><td scope="row">EX-99.1</td></tr>
</table>`

const RELEASE = `<html><body><div>AMAZON.COM ANNOUNCES THIRD QUARTER RESULTS</div>
<div>&#8226;AWS segment sales increased 39% year-over-year to $46.0 billion.</div>
<div>Net income was driven by pre-tax gains of $9.5 billion from our investments in Anthropic.</div></body></html>`

function routeSec(url: string): unknown {
  if (url.endsWith('company_tickers.json')) return TICKERS
  if (url.includes('/submissions/CIK0001018724.json')) return SUBMISSIONS
  if (url.endsWith('-index.html')) return INDEX_HTML
  if (url.endsWith('xex991.htm')) return RELEASE
  throw Object.assign(new Error(`404 ${url}`), { statusCode: 404 })
}

describe('ticker → CIK', () => {
  it('resolves moomoo-style and dotted share classes, zero-pads the CIK', async () => {
    ofetch.mockImplementation(async (url: string) => routeSec(url))
    expect(await sec.resolveCik('US.AMZN')).toEqual({ cik: '0001018724', ticker: 'AMZN', title: 'AMAZON COM INC' })
    expect((await sec.resolveCik('BRK.B'))?.cik).toBe('0001067983')
    expect(await sec.resolveCik('NOPE')).toBeNull()
  })

  it('refuses non-US markets without calling SEC', async () => {
    expect(await sec.resolveCik('HK.00700')).toBeNull()
    expect(ofetch).not.toHaveBeenCalled()
  })

  it('sends the SEC_USER_AGENT header, with a contactable default', async () => {
    ofetch.mockImplementation(async (url: string) => routeSec(url))
    await sec.resolveCik('AMZN')
    const opts = ofetch.mock.calls[0]?.[1] as { headers: Record<string, string> }
    expect(opts.headers['User-Agent']).toBe('ai-trader contact@jjteoh.com')

    vi.stubEnv('SEC_USER_AGENT', 'Someone someone@example.com')
    expect(sec.secUserAgent()).toBe('Someone someone@example.com')
  })
})

describe('pure helpers', () => {
  it('picks the most recent 8-K carrying Item 2.02', () => {
    const f = sec.findLatestEarnings8K(SUBMISSIONS)
    expect(f).toMatchObject({ accession: '0001018724-26-000038', filingDate: '2026-10-29', form: '8-K' })
  })

  it('returns null when no 8-K has Item 2.02', () => {
    const none = { filings: { recent: { ...SUBMISSIONS.filings.recent, items: ['', '5.02', '7.01'] } } }
    expect(sec.findLatestEarnings8K(none)).toBeNull()
  })

  it('finds the EX-99.1 link in a filing index', () => {
    expect(sec.findExhibit991(INDEX_HTML)).toBe('https://www.sec.gov/Archives/edgar/data/1018724/000101872426000038/amzn-20260930xex991.htm')
    expect(sec.findExhibit991('<table></table>')).toBeNull()
  })
})

describe('getLatestEarningsRelease', () => {
  it('returns readable release text with the source URLs', async () => {
    ofetch.mockImplementation(async (url: string) => routeSec(url))
    const r = await sec.getLatestEarningsRelease('US.AMZN')
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.cik).toBe('0001018724')
    expect(r.filing_date).toBe('2026-10-29')
    expect(r.filing_index_url).toBe('https://www.sec.gov/Archives/edgar/data/1018724/000101872426000038/0001018724-26-000038-index.html')
    expect(r.exhibit_url).toContain('amzn-20260930xex991.htm')
    expect(r.text).toContain('• AWS segment sales increased 39%')
    expect(r.text).toContain('Anthropic')
    expect(r.truncated).toBe(false)
  })

  it('reports not_found for an unknown ticker instead of throwing', async () => {
    ofetch.mockImplementation(async (url: string) => routeSec(url))
    const r = await sec.getLatestEarningsRelease('NOPE')
    expect(r.status).toBe('not_found')
  })
})

// companyconcept facts: Amazon reports 3-month quarters directly; many filers
// only report year-to-date, so quarters are derived by differencing.
function fact(start: string, end: string, val: number, form = '10-Q', filed = '2026-10-30') {
  return { start, end, val, form, filed, fy: 2026, fp: 'Q3' }
}

describe('quarterly cash flow from XBRL', () => {
  it('derives quarters from YTD facts, Q4 from FY − 9M, and sums a TTM', () => {
    const ocfFacts = [
      fact('2025-01-01', '2025-03-31', 10),
      fact('2025-01-01', '2025-06-30', 30),
      fact('2025-01-01', '2025-09-30', 60),
      fact('2025-01-01', '2025-12-31', 100, '10-K', '2026-02-01'),
      fact('2026-01-01', '2026-03-31', 20),
      fact('2026-01-01', '2026-06-30', 50),
      fact('2026-01-01', '2026-09-30', 90),
    ]
    const q = sec.quarterlyFromFacts(ocfFacts)
    expect(q.map(x => [x.end, x.val])).toEqual([
      ['2025-03-31', 10], ['2025-06-30', 20], ['2025-09-30', 30], ['2025-12-31', 40],
      ['2026-03-31', 20], ['2026-06-30', 30], ['2026-09-30', 40],
    ])
    expect(sec.annualFromFacts(ocfFacts)).toEqual([{ end: '2025-12-31', val: 100 }])
  })

  it('prefers a reported 3-month fact over a derived one and keeps the latest filing', () => {
    const facts = [
      fact('2026-07-01', '2026-09-30', 42, '10-Q', '2026-10-30'),
      fact('2026-01-01', '2026-06-30', 100),
      fact('2026-01-01', '2026-09-30', 150),
      fact('2026-07-01', '2026-09-30', 41, '10-Q', '2026-10-01'),
    ]
    const q = sec.quarterlyFromFacts(facts)
    expect(q.find(x => x.end === '2026-09-30')?.val).toBe(42)
  })

  it('builds OCF − capex rows using the capex concept with the freshest data', async () => {
    const ocf = { units: { USD: [
      fact('2025-10-01', '2025-12-31', 40), fact('2026-01-01', '2026-03-31', 17),
      fact('2026-04-01', '2026-06-30', 33), fact('2026-07-01', '2026-09-30', 42),
    ] } }
    const productive = { units: { USD: [
      fact('2025-10-01', '2025-12-31', 39), fact('2026-01-01', '2026-03-31', 43),
      fact('2026-04-01', '2026-06-30', 55), fact('2026-07-01', '2026-09-30', 77),
    ] } }
    const stalePpe = { units: { USD: [fact('2017-07-01', '2017-09-30', 3)] } }
    ofetch.mockImplementation(async (url: string) => {
      if (url.endsWith('company_tickers.json')) return TICKERS
      if (url.includes('NetCashProvidedByUsedInOperatingActivities.json')) return ocf
      if (url.includes('PaymentsToAcquireProductiveAssets.json')) return productive
      if (url.includes('PaymentsToAcquirePropertyPlantAndEquipment.json')) return stalePpe
      throw Object.assign(new Error('404'), { statusCode: 404 })
    })
    const s = await sec.getSecCashflowSeries('AMZN')
    expect(s).not.toBeNull()
    if (!s) return
    expect(s.capex_concept).toBe('PaymentsToAcquireProductiveAssets')
    expect(s.quarterly.at(-1)).toEqual({ period_end: '2026-09-30', operating_cash_flow: 42, capex: 77, fcf: -35 })
    expect(s.ttm).toEqual({ period_end: '2026-09-30', operating_cash_flow: 132, capex: 214, fcf: -82 })
    expect(s.source_urls.some(u => u.includes('PaymentsToAcquireProductiveAssets'))).toBe(true)
  })
})
