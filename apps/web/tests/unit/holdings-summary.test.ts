import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('holdings summary', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('does not add Ghostfolio tracker quantity to moomoo broker quantity', async () => {
    vi.doMock('../../server/llm/mcp', () => ({
      getGhostfolioStatus: vi.fn(async () => 'ok'),
      callGhostfolioTool: vi.fn(async (name: string) => {
        if (name === 'get_portfolio_holdings') {
          return {
            holdings: [{
              symbol: 'NVDA',
              quantity: 10,
              valueInBaseCurrency: 50_000,
              investment: 40_000,
              marketPrice: 5_000,
              netPerformancePercent: 0.25,
            }],
          }
        }
        if (name === 'get_portfolio_details') {
          return { summary: { totalValueInBaseCurrency: 100_000 } }
        }
        if (name === 'get_accounts') {
          return { accounts: [{ name: 'Moomoo tracker' }] }
        }
        return null
      }),
    }))

    vi.doMock('../../server/llm/http', () => ({
      getApiClient: () => ({
        listAccounts: vi.fn(async () => [
          { acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' },
          { acc_id: 'paper', trd_env: 'SIMULATE', acc_role: 'OWNER' },
        ]),
        getPortfolio: vi.fn(async ({ trd_env }: { trd_env: 'REAL' | 'SIMULATE' }) => ({
          cash: trd_env === 'REAL' ? 1_000 : 2_000,
          market_val: trd_env === 'REAL' ? 4_500 : 900,
          total_assets: trd_env === 'REAL' ? 5_500 : 2_900,
          positions: trd_env === 'REAL'
            ? [{
                code: 'US.NVDA',
                qty: 10,
                cost_price: 400,
                current_price: 450,
                market_val: 4_500,
                pl_val: 500,
                pl_ratio: 0.125,
              }]
            : [{
                code: 'US.NVDA',
                qty: 2,
                cost_price: 400,
                current_price: 450,
                market_val: 900,
                pl_val: 100,
                pl_ratio: 0.125,
              }],
        })),
      }),
    }))

    vi.doMock('../../server/lib/yahoo', () => ({
      toYahooSymbol: (symbol: string) => symbol.replace(/^US\./, ''),
    }))

    const { getHoldingForSymbol } = await import('../../server/lib/holdings')
    const out = await getHoldingForSymbol('US.NVDA')

    expect(out.broker_quantity).toBe(10)
    expect(out.tracker_quantity).toBe(10)
    expect(out.paper_quantity).toBe(2)
    expect(out.owned_quantity).toBe(10)
    expect(out.total_quantity).toBe(10)
    expect(out.reconciliation.status).toBe('matched')
    expect(out.allocation_pct).toBe(50)
  })

  it('preserves per-position and cash currency instead of assuming USD', async () => {
    vi.doMock('../../server/llm/mcp', () => ({
      getGhostfolioStatus: vi.fn(async () => 'ok'),
      callGhostfolioTool: vi.fn(async (name: string) => {
        if (name === 'get_portfolio_holdings') {
          return {
            holdings: [{
              symbol: '0700.HK',
              quantity: 100,
              valueInBaseCurrency: 150_000,
              investment: 120_000,
              marketPrice: 320,
              netPerformancePercent: 0.25,
              currency: 'HKD',
            }],
          }
        }
        if (name === 'get_portfolio_details') {
          return { summary: { totalValueInBaseCurrency: 300_000, baseCurrency: 'MYR' } }
        }
        if (name === 'get_accounts') return { accounts: [{ name: 'IBKR' }] }
        return null
      }),
    }))

    vi.doMock('../../server/llm/http', () => ({
      getApiClient: () => ({
        listAccounts: vi.fn(async () => [
          { acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' },
          { acc_id: 'paper', trd_env: 'SIMULATE', acc_role: 'OWNER' },
        ]),
        getPortfolio: vi.fn(async ({ trd_env }: { trd_env: 'REAL' | 'SIMULATE' }) => ({
          // Scalar cash/currency is the HKD base-currency aggregate; the
          // native holdings are USD-only (matching the real account shape).
          cash: trd_env === 'REAL' ? 12_806 : 2_000,
          market_val: 32_000,
          total_assets: trd_env === 'REAL' ? 40_000 : 34_000,
          currency: 'HKD',
          cash_by_currency: { USD: trd_env === 'REAL' ? 1_634 : 256 },
          positions: [{
            code: 'HK.00700',
            qty: 100,
            cost_price: 300,
            current_price: 320,
            market_val: 32_000,
            pl_val: 2_000,
            pl_ratio: 0.0667,
            currency: 'HKD',
          }],
        })),
      }),
    }))

    vi.doMock('../../server/lib/yahoo', () => ({
      toYahooSymbol: (symbol: string) => symbol.replace(/^HK\./, '').replace(/^0*/, '0') + '.HK',
    }))

    const { getHoldingForSymbol } = await import('../../server/lib/holdings')
    const out = await getHoldingForSymbol('HK.00700')

    // Every position carries its real currency, not a USD assumption.
    for (const p of out.positions) {
      expect(p.currency).toBeTruthy()
    }
    expect(out.positions.some(p => p.currency === 'HKD')).toBe(true)
    // Cash is reported in the currency actually held (USD), NOT the HKD
    // base/reporting currency — no phantom HKD balance.
    expect(out.cash_live_by_currency).toEqual({ USD: 1_634 })
    expect(out.cash_paper_by_currency).toEqual({ USD: 256 })
    expect(out.cash_live_by_currency.HKD).toBeUndefined()
    // Ghostfolio net worth currency is surfaced.
    expect(out.net_worth_currency).toBe('MYR')
  })
})
