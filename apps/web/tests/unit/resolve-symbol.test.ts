import { beforeEach, describe, expect, it, vi } from 'vitest'

const search = vi.fn()

vi.mock('yahoo-finance2', () => ({
  default: class {
    search = (...args: unknown[]) => search(...args)
  },
}))

type Resolve = typeof import('../../server/lib/yahoo')['resolveSymbol']
let resolveSymbol: Resolve

beforeEach(async () => {
  vi.resetModules()
  search.mockReset()
  // Nitro auto-import, absent under plain vitest: pass the fn through uncached.
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
  const mod = await import('../../server/lib/yahoo')
  resolveSymbol = mod.resolveSymbol
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
      moomoo: 'US.MU',
      yahoo: 'MU',
      name: 'Micron Technology, Inc.',
      exchange: 'NASDAQ',
      quoteType: 'Equity',
    })
    // Search runs on the Yahoo-form ticker, not the literal "US.MU" string.
    expect(search).toHaveBeenCalledWith('MU', expect.anything())
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
})
