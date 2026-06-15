import { beforeEach, describe, expect, it, vi } from 'vitest'

const search = vi.fn()

vi.mock('yahoo-finance2', () => ({
  default: class {
    search = (...args: unknown[]) => search(...args)
  },
}))

type Resolve = typeof import('../../server/lib/yahoo')['resolveSymbol']
type SearchSymbols = typeof import('../../server/lib/yahoo')['searchSymbols']
let resolveSymbol: Resolve
let searchSymbols: SearchSymbols

beforeEach(async () => {
  vi.resetModules()
  search.mockReset()
  // Nitro auto-import, absent under plain vitest: pass the fn through uncached.
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
  const mod = await import('../../server/lib/yahoo')
  resolveSymbol = mod.resolveSymbol
  searchSymbols = mod.searchSymbols
})

describe('resolveSymbol', () => {
  it('resolves US.MU to Micron Technology (exact equity on a moomoo market)', async () => {
    search.mockResolvedValue({
      quotes: [
        { symbol: 'MU', shortname: 'Micron Technology, Inc.', exchDisp: 'NASDAQ', typeDisp: 'Equity' },
        { symbol: 'MUX', shortname: 'McEwen Mining Inc.', exchDisp: 'NYSE', typeDisp: 'Equity' },
      ],
    })

    const r = await resolveSymbol('US.MU')

    expect(r).toEqual({
      status: 'resolved',
      symbol: 'US.MU',
      moomoo: 'US.MU',
      yahoo: 'MU',
      name: 'Micron Technology, Inc.',
      exchange: 'NASDAQ',
      quoteType: 'Equity',
    })
    // Search runs on the Yahoo-form ticker, not the literal "US.MU" string.
    expect(search).toHaveBeenCalledWith(
      'MU',
      { quotesCount: 10, newsCount: 0 },
      { validateResult: false },
    )
  })

  it('resolves an exact Yahoo equity even when it is not on a moomoo-supported market', async () => {
    search.mockResolvedValue({
      quotes: [
        { symbol: '0097.KL', shortname: 'ViTrox Corporation Berhad', exchDisp: 'Kuala Lumpur', typeDisp: 'Equity' },
        { symbol: '0097.KL-R', shortname: 'ViTrox Rights', exchDisp: 'Kuala Lumpur', typeDisp: 'Equity' },
      ],
    })

    const r = await resolveSymbol('0097.KL')

    expect(r).toEqual({
      status: 'resolved',
      symbol: '0097.KL',
      moomoo: null,
      yahoo: '0097.KL',
      name: 'ViTrox Corporation Berhad',
      exchange: 'Kuala Lumpur',
      quoteType: 'Equity',
    })
    expect(search).toHaveBeenCalledWith(
      '0097.KL',
      { quotesCount: 10, newsCount: 0 },
      { validateResult: false },
    )
  })

  it('resolves a futures contract whose Yahoo ticker matches exactly (GC=F)', async () => {
    search.mockResolvedValue({
      quotes: [
        { symbol: 'GC=F', shortname: 'Gold Aug 26', exchDisp: 'NY Commodity Exchange', typeDisp: 'Future' },
        { symbol: 'GCM.AX', shortname: 'GCMCORP FPO [GCM]', exchDisp: 'Australian', typeDisp: 'Equity' },
      ],
    })

    const r = await resolveSymbol('GC=F')

    expect(r).toEqual({
      status: 'resolved',
      symbol: 'GC=F',
      moomoo: null,
      yahoo: 'GC=F',
      name: 'Gold Aug 26',
      exchange: 'NY Commodity Exchange',
      quoteType: 'Future',
    })
  })

  it('resolves an ETF whose Yahoo ticker matches exactly (SPY)', async () => {
    search.mockResolvedValue({
      quotes: [
        { symbol: 'SPY', shortname: 'SPDR S&P 500 ETF Trust', exchDisp: 'NYSEArca', typeDisp: 'ETF' },
      ],
    })

    const r = await resolveSymbol('SPY')

    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') {
      expect(r.yahoo).toBe('SPY')
      expect(r.quoteType).toBe('ETF')
    }
  })

  it('returns ambiguous when no candidate exactly matches the ticker', async () => {
    search.mockResolvedValue({
      quotes: [
        { symbol: 'BNK.TO', shortname: 'Some Bank A', exchDisp: 'Toronto', typeDisp: 'Equity' },
        { symbol: 'BANKX', shortname: 'Some Bank B', exchDisp: 'NASDAQ', typeDisp: 'Equity' },
      ],
    })

    const r = await resolveSymbol('BANK')

    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') {
      expect(r.candidates.length).toBe(2)
      expect(r.candidates[0]?.yahoo).toBe('BNK.TO')
    }
  })

  it('returns not_found when search yields no quotes', async () => {
    search.mockResolvedValue({ quotes: [] })
    expect(await resolveSymbol('ZZZZNOTREAL')).toEqual({ status: 'not_found' })
  })

  it('returns not_found for blank input without hitting Yahoo', async () => {
    expect(await resolveSymbol('   ')).toEqual({ status: 'not_found' })
    expect(search).not.toHaveBeenCalled()
  })

  it('returns error when Yahoo is unreachable', async () => {
    search.mockRejectedValue(new Error('ENOTFOUND query2.finance.yahoo.com'))
    expect(await resolveSymbol('US.MU')).toEqual({ status: 'error' })
  })

  it('searches symbols with result validation disabled for Yahoo response drift', async () => {
    search.mockImplementation((_query, _queryOptions, moduleOptions?: { validateResult?: boolean }) => {
      if (moduleOptions?.validateResult !== false) {
        throw new Error('Failed Yahoo Schema validation')
      }
      return Promise.resolve({
        quotes: [
          { symbol: 'NVDA', shortname: 'NVIDIA Corporation', exchDisp: 'NASDAQ', typeDisp: 'Equity' },
        ],
      })
    })

    expect(await searchSymbols('NVDA')).toEqual([
      {
        moomoo: 'US.NVDA',
        yahoo: 'NVDA',
        name: 'NVIDIA Corporation',
        exchange: 'NASDAQ',
        type: 'Equity',
      },
    ])
    expect(search).toHaveBeenCalledWith(
      'NVDA',
      { quotesCount: 8, newsCount: 0 },
      { validateResult: false },
    )
  })
})
