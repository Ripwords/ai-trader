import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubNitroCache } from '../fixtures/nitro-cache'

const getSecCashflowSeries = vi.fn()
const fundamentalsTimeSeries = vi.fn()
vi.mock('../../server/lib/sec-edgar', () => ({ getSecCashflowSeries: (s: string) => getSecCashflowSeries(s) }))
vi.mock('../../server/lib/yahoo', () => ({
  toYahooSymbol: (s: string) => s.replace(/^US\./, ''),
  yahooClient: { fundamentalsTimeSeries: (...a: unknown[]) => fundamentalsTimeSeries(...a) },
}))

type Mod = typeof import('../../server/lib/cashflow-series')
let mod: Mod

beforeEach(async () => {
  vi.resetModules()
  getSecCashflowSeries.mockReset()
  fundamentalsTimeSeries.mockReset()
  stubNitroCache()
  mod = await import('../../server/lib/cashflow-series')
})

const SEC = {
  cik: '0001018724',
  capex_concept: 'PaymentsToAcquireProductiveAssets',
  quarterly: [
    { period_end: '2026-06-30', operating_cash_flow: 33e9, capex: 55e9, fcf: -22e9 },
    { period_end: '2026-09-30', operating_cash_flow: 42.422e9, capex: 77.259e9, fcf: -34.837e9 },
  ],
  ttm: { period_end: '2026-09-30', operating_cash_flow: 168.3e9, capex: 215.192e9, fcf: -46.892e9 },
  annual: [{ period_end: '2025-12-31', operating_cash_flow: 139.514e9, capex: 131.819e9, fcf: 7.695e9 }],
  source_urls: ['https://data.sec.gov/api/xbrl/companyconcept/CIK0001018724/us-gaap/NetCashProvidedByUsedInOperatingActivities.json'],
}

function ts(date: string | number, ocf: number, capex: number) {
  return { date, operatingCashFlow: ocf, capitalExpenditure: capex, freeCashFlow: ocf + capex }
}

describe('getCashflowSeries', () => {
  it('uses SEC XBRL when the company files with SEC, labelling every period', async () => {
    getSecCashflowSeries.mockResolvedValue(SEC)
    const s = await mod.getCashflowSeries('US.AMZN')
    expect(s?.source).toMatch(/SEC EDGAR XBRL/)
    expect(s?.definition).toBe('FCF = operating cash flow − capital expenditures (purchases of property and equipment)')
    expect(s?.quarterly.at(-1)).toMatchObject({ period_end: '2026-09-30', label: 'quarter ended 2026-09-30', fcf: -34.837e9 })
    expect(s?.ttm).toMatchObject({ label: 'TTM to 2026-09-30', fcf: -46.892e9 })
    expect(s?.annual[0]?.label).toBe('fiscal year ended 2025-12-31')
    expect(s?.source_urls[0]).toContain('data.sec.gov')
    expect(fundamentalsTimeSeries).not.toHaveBeenCalled()
  })

  it('falls back to Yahoo fundamentalsTimeSeries, with capex made positive and staleness noted', async () => {
    getSecCashflowSeries.mockResolvedValue(null)
    fundamentalsTimeSeries.mockImplementation(async (_s: string, q: { type: string }) => {
      if (q.type === 'quarterly') return [ts(new Date('2026-03-31T00:00:00Z').toISOString(), 26.032e9, -44.203e9)]
      if (q.type === 'trailing') return [ts(1790726400, 168.3e9, -215.192e9)]
      return [ts('2025-12-31T00:00:00.000Z', 139.514e9, -131.819e9)]
    })
    const s = await mod.getCashflowSeries('HK.00700')
    expect(s?.source).toMatch(/Yahoo Finance fundamentalsTimeSeries/)
    expect(s?.quarterly[0]).toMatchObject({ period_end: '2026-03-31', operating_cash_flow: 26.032e9, capex: 44.203e9, fcf: 26.032e9 - 44.203e9 })
    expect(s?.ttm).toMatchObject({ period_end: '2026-09-30', fcf: 168.3e9 - 215.192e9 })
    expect(s?.notes.join(' ')).toMatch(/latest quarter.*2026-03-31.*TTM.*2026-09-30/)
  })

  it('returns null when neither source has data', async () => {
    getSecCashflowSeries.mockResolvedValue(null)
    fundamentalsTimeSeries.mockResolvedValue([])
    expect(await mod.getCashflowSeries('ZZZ')).toBeNull()
  })

  it('treats an SEC outage as a reason to try Yahoo, not a failure', async () => {
    getSecCashflowSeries.mockRejectedValue(new Error('503'))
    fundamentalsTimeSeries.mockImplementation(async (_s: string, q: { type: string }) =>
      q.type === 'trailing' ? [ts(1790726400, 10, -4)] : [])
    const s = await mod.getCashflowSeries('AMZN')
    expect(s?.ttm?.fcf).toBe(6)
  })
})

describe('getTtmCashflow', () => {
  it('returns just the TTM figures with their period end for the valuation input', async () => {
    getSecCashflowSeries.mockResolvedValue(SEC)
    expect(await mod.getTtmCashflow('AMZN')).toEqual({
      period_end: '2026-09-30', operating_cash_flow: 168.3e9, capex: 215.192e9, fcf: -46.892e9, source: 'SEC EDGAR XBRL',
    })
  })

  it('is fail-soft', async () => {
    getSecCashflowSeries.mockRejectedValue(new Error('down'))
    fundamentalsTimeSeries.mockRejectedValue(new Error('down'))
    expect(await mod.getTtmCashflow('AMZN')).toBeNull()
  })
})
