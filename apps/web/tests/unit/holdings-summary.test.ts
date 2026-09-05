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
    // moomoo reports pl_ratio as a fraction, Ghostfolio as a fraction too;
    // both land in the same list as percents.
    expect(out.positions.find(p => p.source === 'moomoo_live')?.unrealized_pnl_pct).toBeCloseTo(12.5)
    expect(out.positions.find(p => p.source === 'ghostfolio')?.unrealized_pnl_pct).toBeCloseTo(25)
  })

  it('reads the live Ghostfolio shape, where instrument fields sit under assetProfile', async () => {
    // Captured from mhajder/ghostfolio-mcp get_portfolio_holdings on
    // 2026-09-05. The top-level symbol the parser used to require is absent,
    // so every holding was silently dropped: no positions on /portfolio, no
    // allocation buckets, no tracker quantity in holdings_context.
    vi.doMock('../../server/llm/mcp', () => ({
      getGhostfolioStatus: vi.fn(async () => 'ok'),
      callGhostfolioTool: vi.fn(async (name: string) => {
        if (name === 'get_portfolio_holdings') {
          return {
            holdings: [{
              activitiesCount: 34,
              marketPrice: 230.36,
              allocationInPercentage: 0.0637,
              investment: 6755.98,
              netPerformancePercent: 0.6193,
              quantity: 10.0129,
              valueInBaseCurrency: 9319.93,
              assetProfile: {
                assetClass: 'EQUITY', assetSubClass: 'STOCK', currency: 'USD', dataSource: 'YAHOO',
                name: 'NVIDIA Corporation', sectors: [{ name: 'Technology', weight: 1 }], symbol: 'NVDA',
              },
            }],
          }
        }
        if (name === 'get_portfolio_details') {
          return { summary: { totalValueInBaseCurrency: 146_306.76, baseCurrency: 'MYR', cash: 5_482.35 } }
        }
        if (name === 'get_accounts') return { accounts: [{ name: 'Moomoo' }] }
        return null
      }),
    }))
    vi.doMock('../../server/llm/http', () => ({
      getApiClient: () => ({
        listAccounts: vi.fn(async () => [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }]),
        getPortfolio: vi.fn(async () => ({
          cash: 1_118, market_val: 2_306, total_assets: 3_424, currency: 'MYR',
          cash_by_currency: { USD: 1_118 },
          positions: [{ code: 'US.NVDA', qty: 10, cost_price: 167, current_price: 230.6, market_val: 2_306.76, pl_val: 635, pl_ratio: 0.38, currency: 'USD' }],
        })),
      }),
    }))

    const { getFullPortfolio, getHoldingForSymbol } = await import('../../server/lib/holdings')
    const full = await getFullPortfolio()
    expect(full.positions).toHaveLength(1)
    expect(full.positions[0]).toMatchObject({
      symbol: 'NVDA', name: 'NVIDIA Corporation', quantity: 10.0129, market_value: 9319.93,
      asset_class: 'EQUITY', sectors: ['Technology'], currency: 'USD',
    })
    expect(full.positions[0]!.pnl_pct).toBeCloseTo(61.93)

    const out = await getHoldingForSymbol('US.NVDA')
    expect(out.tracker_quantity).toBeCloseTo(10.0129)
    expect(out.broker_quantity).toBe(10)
    // A fractional dividend-reinvestment sliver is agreement, not a mismatch.
    expect(out.reconciliation.status).toBe('matched')
    expect(out.allocation_pct).toBeCloseTo(6.37, 1)
  })

  it('still flags a whole-share difference as a mismatch', async () => {
    vi.doMock('../../server/llm/mcp', () => ({
      getGhostfolioStatus: vi.fn(async () => 'ok'),
      callGhostfolioTool: vi.fn(async (name: string) => {
        if (name === 'get_portfolio_holdings') {
          return { holdings: [{ quantity: 1010, valueInBaseCurrency: 1, assetProfile: { symbol: 'NVDA' } }] }
        }
        if (name === 'get_portfolio_details') return { summary: { totalValueInBaseCurrency: 1, baseCurrency: 'MYR' } }
        return null
      }),
    }))
    vi.doMock('../../server/llm/http', () => ({
      getApiClient: () => ({
        listAccounts: vi.fn(async () => [{ acc_id: 'live', trd_env: 'REAL', acc_role: 'OWNER' }]),
        getPortfolio: vi.fn(async () => ({
          cash: 0, market_val: 0, total_assets: 0, currency: 'MYR', cash_by_currency: {},
          positions: [{ code: 'US.NVDA', qty: 1000, cost_price: 1, current_price: 1, market_val: 1000, pl_val: 0, pl_ratio: 0, currency: 'USD' }],
        })),
      }),
    }))
    const { getHoldingForSymbol } = await import('../../server/lib/holdings')
    const out = await getHoldingForSymbol('US.NVDA')
    expect(out.reconciliation.status).toBe('mismatch')
    expect(out.reconciliation.quantity_delta).toBe(10)
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
