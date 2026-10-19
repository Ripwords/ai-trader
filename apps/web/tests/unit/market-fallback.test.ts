import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../server/llm/http'

const yahooMock = vi.hoisted(() => ({
  getYahooBars: vi.fn(),
  getYahooQuote: vi.fn(),
}))

vi.mock('../../server/lib/yahoo', () => yahooMock)

const { klineWithFallback, snapshotWithFallback } = await import('../../server/lib/market-fallback')

// ofetch rejects with the api's JSON body on `data`.
function apiError(detail: string): Error {
  return Object.assign(new Error('502 Bad Gateway'), { statusCode: 502, data: { detail } })
}

const NO_PERMISSION = 'get_kline failed: No permission to get quotes for MY.1066. Please check MY Security MarketStocks quote permissions.'

function client(over: Partial<ApiClient>): ApiClient {
  return over as ApiClient
}

const yahooBar = { time: '2026-10-16', open: 6.1, high: 6.2, low: 6.0, close: 6.15, volume: 1000 }

beforeEach(() => {
  yahooMock.getYahooBars.mockReset()
  yahooMock.getYahooQuote.mockReset()
})

describe('klineWithFallback', () => {
  it('returns moomoo bars untouched when moomoo answers', async () => {
    const moomoo = { code: 'US.NVDA', ktype: '1d' as const, bars: [] }
    const out = await klineWithFallback(client({ getKline: vi.fn(async () => moomoo) }), { code: 'US.NVDA', ktype: '1d', num: 5 })
    expect(out).toBe(moomoo)
    expect(yahooMock.getYahooBars).not.toHaveBeenCalled()
  })

  it('falls back to delayed Yahoo bars when moomoo refuses, and says why', async () => {
    yahooMock.getYahooBars.mockResolvedValue([yahooBar])
    const out = await klineWithFallback(
      client({ getKline: vi.fn(async () => { throw apiError(NO_PERMISSION) }) }),
      { code: 'MY.1066', ktype: '1w', num: 30 },
    )
    expect(yahooMock.getYahooBars).toHaveBeenCalledWith('MY.1066', '1wk', 30)
    expect(out).toEqual({
      code: 'MY.1066',
      ktype: '1w',
      bars: [{ ...yahooBar, turnover: null }],
      source: 'yahoo',
      delayed: true,
      fallbackReason: NO_PERMISSION,
    })
  })

  it('does not fall back for intraday candles, which Yahoo cannot match', async () => {
    const err = apiError(NO_PERMISSION)
    await expect(klineWithFallback(
      client({ getKline: vi.fn(async () => { throw err }) }),
      { code: 'MY.1066', ktype: '5m', num: 30 },
    )).rejects.toBe(err)
    expect(yahooMock.getYahooBars).not.toHaveBeenCalled()
  })

  it('rethrows the moomoo error when Yahoo has nothing either', async () => {
    const err = apiError(NO_PERMISSION)
    yahooMock.getYahooBars.mockResolvedValue([])
    await expect(klineWithFallback(
      client({ getKline: vi.fn(async () => { throw err }) }),
      { code: 'MY.1066', ktype: '1d', num: 30 },
    )).rejects.toBe(err)
  })
})

describe('snapshotWithFallback', () => {
  it('falls back to a delayed Yahoo quote when moomoo refuses', async () => {
    yahooMock.getYahooQuote.mockResolvedValue({
      name: 'RHB Bank', lastPrice: 6.15, openPrice: 6.1, highPrice: 6.2, lowPrice: 6.0,
      prevClosePrice: 6.05, changeRate: 1.65, volume: 1000, updateTime: '2026-10-16T09:00:00.000Z',
    })
    const out = await snapshotWithFallback(
      client({ getSnapshot: vi.fn(async () => { throw apiError('get_market_snapshot failed: No permission') }) }),
      { code: 'MY.1066' },
    )
    expect(yahooMock.getYahooQuote).toHaveBeenCalledWith('MY.1066')
    expect(out).toMatchObject({
      code: 'MY.1066', name: 'RHB Bank', lastPrice: 6.15, turnover: null,
      source: 'yahoo', delayed: true, fallbackReason: 'get_market_snapshot failed: No permission',
    })
  })

  it('rethrows the moomoo error when Yahoo has no quote', async () => {
    const err = apiError('get_market_snapshot failed: No permission')
    yahooMock.getYahooQuote.mockResolvedValue(null)
    await expect(snapshotWithFallback(
      client({ getSnapshot: vi.fn(async () => { throw err }) }),
      { code: 'MY.1066' },
    )).rejects.toBe(err)
  })
})
