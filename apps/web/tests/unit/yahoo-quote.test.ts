import { beforeEach, describe, expect, it, vi } from 'vitest'

const quote = vi.fn()

vi.mock('yahoo-finance2', () => ({
  default: class {
    quote = (...args: unknown[]) => quote(...args)
  },
}))

beforeEach(() => {
  vi.resetModules()
  quote.mockReset()
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
})

describe('getYahooQuote', () => {
  it('maps the moomoo symbol and returns changeRate as a decimal, like moomoo', async () => {
    quote.mockResolvedValue({
      longName: 'RHB Bank Berhad',
      regularMarketPrice: 7.2,
      regularMarketPreviousClose: 7.08,
      regularMarketChangePercent: 1.69,
      regularMarketTime: new Date('2026-10-17T09:00:00.000Z'),
    })
    const { getYahooQuote } = await import('../../server/lib/yahoo')

    const q = await getYahooQuote('MY.1066')

    expect(quote).toHaveBeenCalledWith('1066.KL')
    expect(q).toMatchObject({ name: 'RHB Bank Berhad', lastPrice: 7.2, prevClosePrice: 7.08, updateTime: '2026-10-17T09:00:00.000Z' })
    expect(q?.changeRate).toBeCloseTo(0.0169, 6)
  })

  it('returns null when Yahoo has no price', async () => {
    quote.mockResolvedValue({ longName: 'Nothing' })
    const { getYahooQuote } = await import('../../server/lib/yahoo')
    expect(await getYahooQuote('MY.9999')).toBeNull()
  })
})
