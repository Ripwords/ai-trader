import { beforeEach, describe, expect, it, vi } from 'vitest'

const quoteSummary = vi.fn()
const quote = vi.fn()

vi.mock('yahoo-finance2', () => ({
  default: class {
    quoteSummary = (...args: unknown[]) => quoteSummary(...args)
    quote = (...args: unknown[]) => quote(...args)
  },
}))
vi.mock('../../server/lib/sec-edgar', () => ({ getSecQuarterlyOperatingIncome: vi.fn() }))

// Yahoo's priceToSalesTrailing12Months divides the market cap in the trading
// currency by revenue in the reporting currency. HSBC: 2.32T HKD / 67.44B USD.
const summary = (currency: string, financialCurrency: string, ps: number) => ({
  summaryDetail: { marketCap: 2.32e12, priceToSalesTrailing12Months: ps, beta: 1 },
  defaultKeyStatistics: { priceToBook: 1.7 },
  financialData: { financialCurrency },
  price: { currency },
  assetProfile: { sector: 'Financial Services', industry: 'Banks - Diversified' },
})

beforeEach(() => {
  vi.resetModules()
  quoteSummary.mockReset()
  quote.mockReset().mockResolvedValue({ regularMarketPrice: 0.1275 })
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
})

describe('getFinancialMetrics price/sales', () => {
  it('puts the market cap in the reporting currency when the quote trades in another', async () => {
    quoteSummary.mockResolvedValue(summary('HKD', 'USD', 34.406567))
    const { getFinancialMetrics } = await import('../../server/lib/yahoo')
    const m = await getFinancialMetrics('HK.00005')
    expect(quote).toHaveBeenCalledWith('HKDUSD=X')
    expect(m.ps_ratio).toBeCloseTo(34.406567 * 0.1275, 6)
    expect(m.pb_ratio).toBe(1.7)
  })

  it('drops the ratio rather than report a mixed-currency one when no FX rate exists', async () => {
    quoteSummary.mockResolvedValue(summary('HKD', 'USD', 34.4))
    quote.mockRejectedValue(new Error('ETIMEDOUT'))
    const { getFinancialMetrics } = await import('../../server/lib/yahoo')
    expect((await getFinancialMetrics('HK.00005')).ps_ratio).toBeNull()
  })

  it("keeps Yahoo's ratio when both are in one currency", async () => {
    quoteSummary.mockResolvedValue(summary('USD', 'USD', 10.77))
    const { getFinancialMetrics } = await import('../../server/lib/yahoo')
    expect((await getFinancialMetrics('US.AAPL')).ps_ratio).toBe(10.77)
    expect(quote).not.toHaveBeenCalled()
  })
})

describe('getFinancialMetrics industry', () => {
  it('carries the industry so the valuation can tell a bank from an operating company', async () => {
    quoteSummary.mockResolvedValue(summary('USD', 'USD', 4.7))
    const { getFinancialMetrics } = await import('../../server/lib/yahoo')
    const m = await getFinancialMetrics('US.JPM')
    expect(m.industry).toBe('Banks - Diversified')
    expect(quoteSummary).toHaveBeenCalledWith('JPM', expect.objectContaining({ modules: expect.arrayContaining(['assetProfile']) }))
  })
})
