import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RiskReport, RiskReportEvent } from '../../types/research'

const getSnapshot = vi.fn()
const getKline = vi.fn()
const generateRiskReport = vi.fn()
const getYahooBars = vi.fn()
const getYahooQuote = vi.fn()

vi.mock('../../server/llm/http', () => ({
  getApiClient: () => ({ getSnapshot, getKline }),
}))

vi.mock('../../server/llm/risk-report', () => ({
  buildChartSummary: () => '',
  generateRiskReport: (...args: unknown[]) => generateRiskReport(...args),
}))

vi.mock('../../server/lib/yahoo', () => ({
  getFinancialMetrics: vi.fn(async () => ({})),
  getQuarterlyHistory: vi.fn(async () => []),
  getEarningsInfo: vi.fn(async () => ({ last_earnings_date: null })),
  getCompanyNews: vi.fn(async () => []),
  getYahooBars: (...args: unknown[]) => getYahooBars(...args),
  getYahooQuote: (...args: unknown[]) => getYahooQuote(...args),
}))

const pillar = (score: number) => ({ score, label: 'x', summary: 'x', points: [] })
const LLM = {
  kpis: [],
  valuation: pillar(50),
  health: pillar(50),
  growth: pillar(50),
  markers: [],
  catalysts: ['c'],
  risks: ['r'],
  bottom_line: 'fine',
  rating: 'HOLD',
}

let store: Map<string, unknown>
let setOpts: Map<string, unknown>

beforeEach(() => {
  vi.resetModules()
  store = new Map()
  setOpts = new Map()
  getSnapshot.mockReset().mockResolvedValue({ name: 'Apple', lastPrice: 200, prevClosePrice: 190, changeRate: 5.26 })
  getKline.mockReset().mockResolvedValue({ bars: [{ time: '2026-10-17', open: 1, high: 2, low: 1, close: 2, volume: 10 }] })
  generateRiskReport.mockReset().mockResolvedValue({ llm: LLM })
  getYahooBars.mockReset().mockResolvedValue([])
  getYahooQuote.mockReset().mockResolvedValue(null)
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
  vi.stubGlobal('useStorage', (base?: string) => {
    const prefix = base ? `${base}:` : ''
    return {
      getItem: async (k: string) => store.get(prefix + k) ?? null,
      setItem: async (k: string, v: unknown, opts?: unknown) => {
        store.set(prefix + k, v)
        setOpts.set(prefix + k, opts)
      },
    }
  })
})

async function drain(gen: AsyncGenerator<RiskReportEvent>): Promise<RiskReportEvent[]> {
  const out: RiskReportEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describe('streamRiskReport caching', () => {
  it('stores a finished report with a TTL and replays it as one cached event', async () => {
    const { streamRiskReport } = await import('../../server/lib/risk-report')

    const first = await drain(streamRiskReport({ symbol: 'US.AAPL' }))
    expect(first.at(-1)?.kind).toBe('done')
    expect(generateRiskReport).toHaveBeenCalledTimes(1)
    expect(setOpts.get('cache:risk-report:US.AAPL.json')).toEqual({ ttl: expect.any(Number) })

    const second = await drain(streamRiskReport({ symbol: 'US.AAPL' }))
    expect(second).toHaveLength(1)
    const ev = second[0]
    expect(ev?.kind).toBe('cached')
    const report = (ev as { report: RiskReport }).report
    expect(report).toMatchObject({ symbol: 'US.AAPL', name: 'Apple', cached: true, rating: 'HOLD', risk_score: 50 })
    expect(report.chart.bars).toHaveLength(1)
    expect(report.price.last).toBe(200)
    expect(generateRiskReport).toHaveBeenCalledTimes(1)
  })

  it('regenerates when refresh is set, and overwrites the stored report', async () => {
    const { streamRiskReport } = await import('../../server/lib/risk-report')
    await drain(streamRiskReport({ symbol: 'US.AAPL' }))
    generateRiskReport.mockResolvedValue({ llm: { ...LLM, rating: 'BUY' } })

    const events = await drain(streamRiskReport({ symbol: 'US.AAPL', refresh: true }))
    expect(events.some(e => e.kind === 'cached')).toBe(false)
    expect(generateRiskReport).toHaveBeenCalledTimes(2)
    expect((store.get('cache:risk-report:US.AAPL.json') as RiskReport).rating).toBe('BUY')
  })

  it('ignores a stored report older than the stale time', async () => {
    const { streamRiskReport, RISK_REPORT_TTL_SECONDS } = await import('../../server/lib/risk-report')
    await drain(streamRiskReport({ symbol: 'US.AAPL' }))
    const stored = store.get('cache:risk-report:US.AAPL.json') as RiskReport
    stored.generated_at = new Date(Date.now() - (RISK_REPORT_TTL_SECONDS + 60) * 1000).toISOString()

    const events = await drain(streamRiskReport({ symbol: 'US.AAPL' }))
    expect(events[0]?.kind).toBe('meta')
    expect(generateRiskReport).toHaveBeenCalledTimes(2)
  })

  it('does not cache a report built without moomoo price or chart data', async () => {
    getSnapshot.mockRejectedValue(new Error('opend down'))
    const { streamRiskReport } = await import('../../server/lib/risk-report')
    const events = await drain(streamRiskReport({ symbol: 'US.AAPL' }))
    expect(events.at(-1)?.kind).toBe('done')
    expect(store.has('cache:risk-report:US.AAPL.json')).toBe(false)
  })

  it('still streams the report when the cache store is unreachable', async () => {
    vi.stubGlobal('useStorage', () => ({
      getItem: async () => { throw new Error('ECONNREFUSED') },
      setItem: async () => { throw new Error('ECONNREFUSED') },
    }))
    const { streamRiskReport } = await import('../../server/lib/risk-report')
    const events = await drain(streamRiskReport({ symbol: 'US.AAPL' }))
    expect(events.at(-1)?.kind).toBe('done')
  })
})

describe('streamRiskReport Yahoo fallback', () => {
  const NO_PERMISSION = Object.assign(new Error('502 Bad Gateway'), {
    data: { detail: 'get_market_snapshot failed: No permission to get quotes for MY.1066.' },
  })

  it('labels a moomoo price as moomoo and prices US symbols in USD', async () => {
    const { streamRiskReport } = await import('../../server/lib/risk-report')
    const events = await drain(streamRiskReport({ symbol: 'US.AAPL' }))
    const price = events.find(e => e.kind === 'price')
    expect(price).toMatchObject({ price: { last: 200, currency: 'USD', source: 'moomoo' } })
  })

  it('builds the price and chart from delayed Yahoo data when moomoo refuses the market', async () => {
    getSnapshot.mockRejectedValue(NO_PERMISSION)
    getKline.mockRejectedValue(NO_PERMISSION)
    getYahooQuote.mockResolvedValue({
      name: 'RHB Bank Berhad', lastPrice: 7.2, openPrice: 7.1, highPrice: 7.25, lowPrice: 7.05,
      prevClosePrice: 7.08, changeRate: 0.0169, volume: 1000, updateTime: null,
    })
    getYahooBars.mockResolvedValue([
      { time: '2026-10-16', open: 7, high: 7.1, low: 6.9, close: 7.08, volume: 900 },
      { time: '2026-10-17', open: 7.1, high: 7.25, low: 7.05, close: 7.2, volume: 1000 },
    ])
    const { streamRiskReport } = await import('../../server/lib/risk-report')

    const events = await drain(streamRiskReport({ symbol: 'MY.1066' }))

    expect(getYahooBars).toHaveBeenCalledWith('MY.1066', '1d', 252)
    expect(events.find(e => e.kind === 'price')).toMatchObject({
      price: { last: 7.2, change_pct: 0.0169, currency: 'MYR', source: 'yahoo' },
    })
    const change = (events.find(e => e.kind === 'price') as { price: { change: number } }).price.change
    expect(change).toBeCloseTo(0.12, 6)
    expect(events.find(e => e.kind === 'meta' && e.name !== null)).toMatchObject({ name: 'RHB Bank Berhad' })
    const chart = events.find(e => e.kind === 'chart') as { bars: unknown[] }
    expect(chart.bars).toHaveLength(2)
    expect(generateRiskReport).toHaveBeenCalledWith(expect.objectContaining({
      price: expect.objectContaining({ last: 7.2, currency: 'MYR' }),
    }))
    const stored = store.get('cache:risk-report:MY.1066.json') as RiskReport
    expect(stored.price).toMatchObject({ currency: 'MYR', source: 'yahoo' })
  })
})
