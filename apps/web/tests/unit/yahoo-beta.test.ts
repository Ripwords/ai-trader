import { beforeEach, describe, expect, it, vi } from 'vitest'

const quoteSummary = vi.fn()
const chart = vi.fn()

vi.mock('yahoo-finance2', () => ({
  default: class {
    quoteSummary = (...args: unknown[]) => quoteSummary(...args)
    chart = (...args: unknown[]) => chart(...args)
  },
}))
vi.mock('../../server/lib/sec-edgar', () => ({ getSecQuarterlyOperatingIncome: vi.fn() }))

// Month-end closes: the index moves by `moves`, the stock by `k` times that.
function closes(moves: number[], k: number, start = 100) {
  const out = [{ time: '2021-10-01', close: start }]
  moves.forEach((m, i) => {
    const prev = out[i]?.close ?? start
    const month = new Date(Date.UTC(2021, 10 + i, 1)).toISOString().slice(0, 10)
    out.push({ time: month, close: prev * (1 + k * m) })
  })
  return out
}
const MOVES = Array.from({ length: 60 }, (_, i) => ((i * 7) % 11 - 5) / 100)

const bar = (c: { time: string, close: number }) => ({ date: new Date(c.time), open: c.close, high: c.close, low: c.close, close: c.close, volume: 1 })

beforeEach(() => {
  vi.resetModules()
  quoteSummary.mockReset().mockResolvedValue({
    summaryDetail: { marketCap: 2.6e12 },
    defaultKeyStatistics: {},
    financialData: {},
    price: { currency: 'USD' },
  })
  chart.mockReset().mockImplementation(async (sym: string) => ({
    quotes: (sym === '^GSPC' ? closes(MOVES, 1) : closes(MOVES, 1.4)).map(bar),
  }))
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
})

describe('betaFromCloses', () => {
  it('is the slope of monthly stock returns on index returns', async () => {
    const { betaFromCloses } = await import('../../server/lib/yahoo')
    expect(betaFromCloses(closes(MOVES, 1.4), closes(MOVES, 1))).toBeCloseTo(1.4, 6)
  })

  it('pairs months by date, so a missing month is skipped rather than shifted', async () => {
    const { betaFromCloses } = await import('../../server/lib/yahoo')
    const stock = closes(MOVES, 1.4)
    stock.splice(30, 1)
    const b = betaFromCloses(stock, closes(MOVES, 1))
    expect(b).not.toBeNull()
    expect(b as number).toBeCloseTo(1.4, 1)
  })

  it('is null with under two years of overlapping months', async () => {
    const { betaFromCloses } = await import('../../server/lib/yahoo')
    expect(betaFromCloses(closes(MOVES.slice(0, 20), 1.4), closes(MOVES, 1))).toBeNull()
  })
})

describe('getFinancialMetrics beta', () => {
  it('computes beta against the S&P 500 when Yahoo has none', async () => {
    const { getFinancialMetrics } = await import('../../server/lib/yahoo')
    const m = await getFinancialMetrics('US.AMZN')
    expect(m.beta).toBeCloseTo(1.4, 2)
    expect(chart).toHaveBeenCalledWith('^GSPC', expect.objectContaining({ interval: '1mo' }))
  })

  it("keeps Yahoo's beta and fetches no prices when it has one", async () => {
    quoteSummary.mockResolvedValue({ summaryDetail: { beta: 1.07 }, defaultKeyStatistics: {}, financialData: {}, price: {} })
    const { getFinancialMetrics } = await import('../../server/lib/yahoo')
    expect((await getFinancialMetrics('US.AAPL')).beta).toBe(1.07)
    expect(chart).not.toHaveBeenCalled()
  })

  it('leaves beta null for a market without a benchmark, or when prices fail', async () => {
    const { getFinancialMetrics } = await import('../../server/lib/yahoo')
    expect((await getFinancialMetrics('SG.D05')).beta).toBeNull()
    chart.mockRejectedValue(new Error('ETIMEDOUT'))
    expect((await getFinancialMetrics('US.AMZN')).beta).toBeNull()
  })
})
