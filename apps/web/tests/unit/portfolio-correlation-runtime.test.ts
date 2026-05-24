import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DailyBar } from '../../server/lib/yahoo'

const getFullPortfolioCached = vi.fn()
const getDailyBars = vi.fn()

vi.mock('../../server/lib/portfolio-cache', () => ({
  getFullPortfolioCached: (...args: unknown[]) => getFullPortfolioCached(...args),
}))

vi.mock('../../server/lib/yahoo', () => ({
  getDailyBars: (...args: unknown[]) => getDailyBars(...args),
}))

function barsFromReturns(returns: number[], start = 100): DailyBar[] {
  let close = start
  const bars: DailyBar[] = [{
    time: '2026-01-01',
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }]

  returns.forEach((r, i) => {
    close = close * (1 + r)
    const day = String(i + 2).padStart(2, '0')
    bars.push({
      time: `2026-01-${day}`,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
    })
  })

  return bars
}

beforeEach(() => {
  vi.resetModules()
  getFullPortfolioCached.mockReset()
  getDailyBars.mockReset()
  vi.stubGlobal('defineCachedFunction', (fn: unknown) => fn)
})

describe('getPortfolioCorrelationCached', () => {
  it('loads current portfolio symbols and builds the cached correlation payload', async () => {
    getFullPortfolioCached.mockResolvedValue({
      positions: [
        { symbol: 'NVDA', name: 'NVIDIA Corporation', market_value: 300 },
        { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', market_value: 700 },
      ],
      moomoo_live: [{ symbol: 'US.TLT' }],
      moomoo_paper: [{ symbol: 'US.NVDA' }],
    })
    getDailyBars.mockImplementation(async (symbol: string) => {
      if (symbol === 'NVDA') return barsFromReturns(Array.from({ length: 24 }, (_, i) => (i + 1) / 100))
      if (symbol === 'TLT') return barsFromReturns(Array.from({ length: 24 }, (_, i) => -(i + 1) / 100))
      return []
    })

    const { getPortfolioCorrelationCached } = await import('../../server/lib/portfolio-correlation')
    const result = await getPortfolioCorrelationCached({ force: true })

    expect(getFullPortfolioCached).toHaveBeenCalledWith({ force: true })
    expect(getDailyBars).toHaveBeenCalledWith('NVDA', 253)
    expect(getDailyBars).toHaveBeenCalledWith('TLT', 253)
    expect(result.symbols).toEqual(['NVDA', 'TLT'])
    expect(result.matrix[0]?.[1]).toBeCloseTo(-1, 6)
    expect(result.current_portfolio?.weights).toEqual({ NVDA: 0.3, TLT: 0.7 })
  })
})
