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
})
