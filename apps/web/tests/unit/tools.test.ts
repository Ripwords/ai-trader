import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../server/llm/http'
import { makeTools } from '../../server/llm/tools'

const portfolioCorrelationMock = vi.hoisted(() => ({
  getPortfolioCorrelationCached: vi.fn(async () => ({
    analysis_basis: 'modern_portfolio_theory',
    generated_at: '2026-05-24T00:00:00.000Z',
    lookback_days: 252,
    min_returns: 20,
    risk_free_rate: 0.02,
    symbols: ['NVDA', 'TLT'],
    assets: [
      { symbol: 'NVDA', name: 'NVIDIA Corporation', observations: 120, weight: 0.7, expected_return_annual: 0.2, volatility_annual: 0.3 },
      { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', observations: 120, weight: 0.3, expected_return_annual: 0.04, volatility_annual: 0.12 },
    ],
    matrix: [
      [1, -0.4],
      [-0.4, 1],
    ],
    covariance_matrix: [
      [0.09, -0.01],
      [-0.01, 0.04],
    ],
    current_portfolio: {
      label: 'current',
      expected_return_annual: 0.15,
      volatility_annual: 0.22,
      sharpe_ratio: 0.59,
      weights: { NVDA: 0.7, TLT: 0.3 },
    },
    min_variance_portfolio: null,
    max_sharpe_portfolio: null,
    efficient_frontier: [],
    simulations: [],
    excluded: [],
  })),
}))

vi.mock('../../server/lib/portfolio-correlation', () => ({
  getPortfolioCorrelationCached: portfolioCorrelationMock.getPortfolioCorrelationCached,
}))

// Stand-in for ApiClient — only the methods our tools call.
function fakeClient() {
  return {
    getKline: vi.fn(async () => ({ code: 'US.NVDA', ktype: '1d', bars: [{ time: 't', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, turnover: 15 }] })),
    getSnapshot: vi.fn(async () => ({ code: 'US.NVDA', name: 'NVIDIA', lastPrice: 100, openPrice: 99, highPrice: 101, lowPrice: 98, prevClosePrice: 99, changeRate: 0.01, volume: 1000, turnover: 100000, updateTime: 't' })),
    getOrderBook: vi.fn(async () => ({ code: 'US.NVDA', name: 'NVIDIA', bids: [{ price: 99, volume: 100, order_count: 1, details: {} }], asks: [{ price: 100, volume: 200, order_count: 2, details: {} }] })),
    listWatchlist: vi.fn(async () => [{ code: 'US.NVDA', name: 'NVIDIA', group: 'All' }]),
    addWatchlistItem: vi.fn(async () => ({ status: 'ok' })),
    removeWatchlistItem: vi.fn(async () => ({ status: 'ok' })),
    listAccounts: vi.fn(async () => [{ acc_id: 1, trd_env: 'SIMULATE' as const, acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'OWNER' }]),
    getPortfolio: vi.fn(async () => ({ cash: 10000, market_val: 5000, total_assets: 15000, positions: [] })),
    listOrders: vi.fn(async () => []),
    listFills: vi.fn(async () => []),
    placeOrder: vi.fn(async args => ({ order_id: 'paper-1', status: 'submitted', ...args, acc_id: args.acc_id ?? '1', price: args.price ?? 0, trd_env: args.trd_env ?? 'SIMULATE' })),
    modifyOrder: vi.fn(async args => ({ order_id: args.order_id, status: 'modified' })),
    cancelOrder: vi.fn(async args => ({ order_id: args.order_id, status: 'cancelled' })),
  }
}

describe('tool catalogue', () => {
  it('exposes the expected tool names', () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    expect(Object.keys(tools).sort()).toEqual([
      'agents_debate',
      'algo_backtest',
      'algo_kill',
      'algo_list',
      'algo_recent_signals',
      'algo_state',
      'algo_unkill',
      'convert_fx',
      'holdings_context',
      'market_kline',
      'market_order_book',
      'market_snapshot',
      'portfolio_mpt_analysis',
      'research_get',
      'research_start',
      'research_status',
      'search_news',
      'search_web',
      'ticker_news_context',
      'trade_account_overview',
      'trade_accounts',
      'trade_cancel_order',
      'trade_fills',
      'trade_modify_order',
      'trade_orders',
      'trade_place_order',
      'trade_portfolio',
      'usage_summary',
      'value_stock',
      'watchlist_add',
      'watchlist_list',
      'watchlist_remove',
    ])
  })

  it('market.kline forwards to client.getKline', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['market_kline'] as { execute: (args: { code: string; ktype: '1d'; num: number }) => Promise<unknown> }).execute({ code: 'US.NVDA', ktype: '1d', num: 5 })
    expect(c.getKline).toHaveBeenCalledWith({ code: 'US.NVDA', ktype: '1d', num: 5 })
    expect((out as { bars: unknown[] }).bars.length).toBe(1)
  })

  it('market.order_book forwards to client.getOrderBook', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['market_order_book'] as { execute: (args: { code: string; num: number }) => Promise<unknown> }).execute({ code: 'US.NVDA', num: 5 })
    expect(c.getOrderBook).toHaveBeenCalledWith({ code: 'US.NVDA', num: 5 })
    expect((out as { asks: unknown[] }).asks.length).toBe(1)
  })

  it('watchlist.list wraps result under {items}', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['watchlist_list'] as { execute: (args: { group: string }) => Promise<unknown> }).execute({ group: 'All' })
    expect((out as { items: unknown[] }).items.length).toBe(1)
  })

  it('trade.account_overview aggregates non-IPO accounts for an environment', async () => {
    const c = fakeClient()
    c.listAccounts.mockResolvedValueOnce([
      { acc_id: '1', trd_env: 'REAL', acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'OWNER' },
      { acc_id: '2', trd_env: 'REAL', acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'IPO' },
      { acc_id: '3', trd_env: 'SIMULATE', acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'OWNER' },
    ])
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['trade_account_overview'] as { execute: (args: { trd_env: 'REAL' }) => Promise<unknown> }).execute({ trd_env: 'REAL' })

    expect(c.getPortfolio).toHaveBeenCalledTimes(1)
    expect(c.getPortfolio).toHaveBeenCalledWith({ acc_id: '1', trd_env: 'REAL' })
    expect(out).toMatchObject({
      trd_env: 'REAL',
      totals: { cash: 10000, market_val: 5000, total_assets: 15000 },
      skipped: [{ acc_id: '2', reason: 'IPO account' }],
    })
  })

  it('portfolio_mpt_analysis returns a compact subset heatmap for chat', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['portfolio_mpt_analysis'] as { execute: (args: {
      view: 'heatmap'
      symbols: string[]
      maxSymbols: number
      subset: 'top_weight'
      sampleLimit: number
      force: boolean
    }) => Promise<unknown> }).execute({
      view: 'heatmap',
      symbols: ['TLT', 'NVDA'],
      maxSymbols: 2,
      subset: 'top_weight',
      sampleLimit: 20,
      force: true,
    })

    expect(portfolioCorrelationMock.getPortfolioCorrelationCached).toHaveBeenCalledWith({ force: true })
    expect(out).toMatchObject({
      view: 'heatmap',
      heatmap: {
        subset_reason: 'requested symbols',
        assets: [{ symbol: 'TLT' }, { symbol: 'NVDA' }],
        matrix: [
          [1, -0.4],
          [-0.4, 1],
        ],
      },
    })
  })

  it('search throws when no provider keys are set', async () => {
    delete process.env.TAVILY_API_KEY
    delete process.env.BRAVE_API_KEY
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    await expect(
      (tools['search_web'] as { execute: (args: { query: string; maxResults: number }) => Promise<unknown> }).execute({ query: 'x', maxResults: 3 }),
    ).rejects.toThrow(/BRAVE_API_KEY|TAVILY_API_KEY|search provider/)
  })

  it('blocks live order placement unless the latest user message includes the exact confirmation phrase', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient, {
      latestUserText: 'yes, place it live',
    })

    await expect(
      (tools['trade_place_order'] as { execute: (args: {
        code: string
        side: 'BUY'
        qty: number
        price: number
        order_type: 'NORMAL'
        trd_env: 'REAL'
      }) => Promise<unknown> }).execute({
        code: 'US.NVDA',
        side: 'BUY',
        qty: 1,
        price: 100,
        order_type: 'NORMAL',
        trd_env: 'REAL',
      }),
    ).rejects.toThrow(/LIVE PLACE BUY 1 US.NVDA NORMAL @ 100/)
    expect(c.placeOrder).not.toHaveBeenCalled()
  })

  it('allows live order placement only when confirmation is copied from the latest user message', async () => {
    const c = fakeClient()
    const phrase = 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 100'
    const tools = makeTools(c as unknown as ApiClient, {
      latestUserText: `confirmed: ${phrase}`,
    })

    const out = await (tools['trade_place_order'] as { execute: (args: {
      code: string
      side: 'BUY'
      qty: number
      price: number
      order_type: 'NORMAL'
      trd_env: 'REAL'
      live_confirmation: string
    }) => Promise<unknown> }).execute({
      code: 'US.NVDA',
      side: 'BUY',
      qty: 1,
      price: 100,
      order_type: 'NORMAL',
      trd_env: 'REAL',
      live_confirmation: phrase,
    })

    expect(c.placeOrder).toHaveBeenCalledWith({
      code: 'US.NVDA',
      side: 'BUY',
      qty: 1,
      price: 100,
      order_type: 'NORMAL',
      trd_env: 'REAL',
    })
    expect((out as { order_id: string }).order_id).toBe('paper-1')
  })
})
