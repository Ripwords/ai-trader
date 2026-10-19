import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RiskReport, RiskReportEvent } from '../../types/research'

const getSnapshot = vi.fn()
const getKline = vi.fn()
const generateRiskReport = vi.fn()

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
