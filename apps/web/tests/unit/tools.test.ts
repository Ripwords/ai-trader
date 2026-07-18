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

const portfolioHistoryMock = vi.hoisted(() => ({
  getPortfolioPerformance: vi.fn(async () => ({
    series: [
      { t: '2026-07-01T08:00:00.000Z', source: 'auto', netWorth: 100000, cash: 20000, positionsValue: 80000, currency: 'MYR' },
      { t: '2026-07-17T08:00:00.000Z', source: 'auto', netWorth: 110000, cash: 21000, positionsValue: 89000, currency: 'MYR' },
    ],
    stats: {
      count: 2,
      firstAt: '2026-07-01T08:00:00.000Z',
      lastAt: '2026-07-17T08:00:00.000Z',
      currency: 'MYR',
      totalReturnPct: 10,
      maxDrawdownPct: -2.5,
      periodReturns: { d1: null, d7: 4, d30: null },
    },
  })),
}))

vi.mock('../../server/lib/portfolio-history', () => ({
  getPortfolioPerformance: portfolioHistoryMock.getPortfolioPerformance,
}))

const paperOrdersMock = vi.hoisted(() => ({
  recordPaperOrder: vi.fn(async () => true),
}))

vi.mock('../../server/lib/paper-orders', () => ({
  recordPaperOrder: paperOrdersMock.recordPaperOrder,
}))

const alertsMock = vi.hoisted(() => ({
  createAlert: vi.fn(async (input: { symbol: string; kind: string; threshold: number; note?: string | null }) => ({
    id: 'alert-1',
    symbol: input.symbol,
    kind: input.kind,
    threshold: input.threshold,
    note: input.note ?? null,
    status: 'active',
    createdAt: '2026-07-18T00:00:00.000Z',
    triggeredAt: null,
    triggeredPrice: null,
  })),
  listAlerts: vi.fn(async () => [] as unknown[]),
  cancelAlert: vi.fn(async () => null),
  resolveSymbolMock: vi.fn(async () => ({
    status: 'resolved' as const,
    symbol: 'US.NVDA',
    moomoo: 'US.NVDA',
    yahoo: 'NVDA',
    name: 'NVIDIA Corporation',
    exchange: 'NASDAQ',
    quoteType: 'Equity',
  })),
}))

vi.mock('../../server/lib/alerts', () => ({
  createAlert: alertsMock.createAlert,
  listAlerts: alertsMock.listAlerts,
  cancelAlert: alertsMock.cancelAlert,
}))

vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: alertsMock.resolveSymbolMock,
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
    listHistoryOrders: vi.fn(async () => [{ order_id: 'ord-h1', code: 'US.NVDA', side: 'BUY' as const, qty: 2, price: 90, status: 'FILLED_ALL', created_at: '2026-07-01 09:30:00' }]),
    listHistoryFills: vi.fn(async () => [{ fill_id: 'fill-h1', order_id: 'ord-h1', code: 'US.NVDA', side: 'BUY' as const, qty: 2, price: 90, fill_at: '2026-07-01 09:31:00' }]),
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
      'alert_cancel',
      'alert_create',
      'alert_list',
      'algo_backtest',
      'algo_kill',
      'algo_list',
      'algo_recent_signals',
      'algo_state',
      'algo_unkill',
      'convert_fx',
      'dyp_ask',
      'holdings_context',
      'investment_research',
      'market_kline',
      'market_order_book',
      'market_snapshot',
      'news_pulse',
      'portfolio_mpt_analysis',
      'portfolio_performance',
      'research_get',
      'research_start',
      'research_status',
      'search_news',
      'search_web',
      'thesis_tracker',
      'ticker_news_context',
      'trade_account_overview',
      'trade_accounts',
      'trade_cancel_order',
      'trade_fills',
      'trade_fills_history',
      'trade_modify_order',
      'trade_orders',
      'trade_orders_history',
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

  it('trade.account_overview groups totals by currency and flags mixed currencies', async () => {
    const c = fakeClient()
    c.listAccounts.mockResolvedValueOnce([
      { acc_id: '1', trd_env: 'REAL', acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'OWNER' },
      { acc_id: '2', trd_env: 'REAL', acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['HK'], acc_role: 'OWNER' },
    ])
    c.getPortfolio
      .mockResolvedValueOnce({ cash: 1000, market_val: 2000, total_assets: 3000, currency: 'USD', positions: [] })
      .mockResolvedValueOnce({ cash: 5000, market_val: 6000, total_assets: 11000, currency: 'HKD', positions: [] })
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['trade_account_overview'] as { execute: (args: { trd_env: 'REAL' }) => Promise<Record<string, unknown>> }).execute({ trd_env: 'REAL' })

    expect(out.mixed_currency).toBe(true)
    expect(out.currencies).toEqual(expect.arrayContaining(['USD', 'HKD']))
    expect(out.totals_by_currency).toMatchObject({
      USD: { cash: 1000, market_val: 2000, total_assets: 3000 },
      HKD: { cash: 5000, market_val: 6000, total_assets: 11000 },
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

  it('trade_orders_history forwards the date range to client.listHistoryOrders', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['trade_orders_history'] as { execute: (args: {
      acc_id: string
      trd_env: 'SIMULATE'
      start: string
      end: string
    }) => Promise<unknown> }).execute({ acc_id: '1', trd_env: 'SIMULATE', start: '2026-06-18', end: '2026-07-18' })
    expect(c.listHistoryOrders).toHaveBeenCalledWith({
      acc_id: '1', trd_env: 'SIMULATE', start: '2026-06-18', end: '2026-07-18',
    })
    expect((out as { orders: unknown[] }).orders).toHaveLength(1)
  })

  it('trade_fills_history forwards the symbol filter to client.listHistoryFills', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['trade_fills_history'] as { execute: (args: {
      acc_id: string
      trd_env: 'REAL'
      code: string
    }) => Promise<unknown> }).execute({ acc_id: '1', trd_env: 'REAL', code: 'US.NVDA' })
    expect(c.listHistoryFills).toHaveBeenCalledWith({
      acc_id: '1', trd_env: 'REAL', code: 'US.NVDA',
    })
    expect((out as { fills: unknown[] }).fills).toHaveLength(1)
  })

  it('portfolio_performance returns the stored equity curve + stats', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['portfolio_performance'] as { execute: (args: { days: number }) => Promise<unknown> })
      .execute({ days: 90 })
    expect(portfolioHistoryMock.getPortfolioPerformance).toHaveBeenCalledWith({ days: 90 })
    expect(out).toMatchObject({
      stats: { totalReturnPct: 10, maxDrawdownPct: -2.5 },
    })
    expect((out as { series: unknown[] }).series).toHaveLength(2)
  })

  it('records a paper_orders ledger row after a SIMULATE placement (best-effort)', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['trade_place_order'] as { execute: (args: {
      code: string
      side: 'BUY'
      qty: number
      price: number
      order_type: 'NORMAL'
      trd_env: 'SIMULATE'
    }) => Promise<unknown> }).execute({
      code: 'US.NVDA', side: 'BUY', qty: 2, price: 100, order_type: 'NORMAL', trd_env: 'SIMULATE',
    })
    expect((out as { order_id: string }).order_id).toBe('paper-1')
    expect(paperOrdersMock.recordPaperOrder).toHaveBeenCalledWith(expect.objectContaining({
      source: 'chat',
      moomooOrderId: 'paper-1',
      symbol: 'US.NVDA',
      side: 'BUY',
      qty: 2,
      trdEnv: 'SIMULATE',
    }))
  })

  it('does not write the paper ledger for REAL placements', async () => {
    paperOrdersMock.recordPaperOrder.mockClear()
    const c = fakeClient()
    const phrase = 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 100'
    const tools = makeTools(c as unknown as ApiClient, { latestUserText: phrase })
    await (tools['trade_place_order'] as { execute: (args: {
      code: string
      side: 'BUY'
      qty: number
      price: number
      order_type: 'NORMAL'
      trd_env: 'REAL'
      live_confirmation: string
    }) => Promise<unknown> }).execute({
      code: 'US.NVDA', side: 'BUY', qty: 1, price: 100, order_type: 'NORMAL', trd_env: 'REAL', live_confirmation: phrase,
    })
    expect(paperOrdersMock.recordPaperOrder).not.toHaveBeenCalled()
  })

  it('alert_create resolves the symbol to canonical form before persisting', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['alert_create'] as { execute: (args: {
      symbol: string
      kind: 'price_above'
      threshold: number
    }) => Promise<unknown> }).execute({ symbol: 'NVDA', kind: 'price_above', threshold: 150 })

    expect(alertsMock.resolveSymbolMock).toHaveBeenCalledWith('NVDA')
    expect(alertsMock.createAlert).toHaveBeenCalledWith({
      symbol: 'US.NVDA',
      kind: 'price_above',
      threshold: 150,
      note: null,
    })
    expect(out).toMatchObject({ alert: { id: 'alert-1', symbol: 'US.NVDA', status: 'active' } })
  })

  it('alert_create surfaces an unresolved symbol instead of guessing', async () => {
    alertsMock.createAlert.mockClear()
    alertsMock.resolveSymbolMock.mockResolvedValueOnce({
      status: 'not_found',
    } as unknown as Awaited<ReturnType<typeof alertsMock.resolveSymbolMock>>)
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['alert_create'] as { execute: (args: {
      symbol: string
      kind: 'price_above'
      threshold: number
    }) => Promise<unknown> }).execute({ symbol: 'ZZZZZ', kind: 'price_above', threshold: 1 })

    expect(alertsMock.createAlert).not.toHaveBeenCalled()
    expect(out).toMatchObject({ error: expect.stringContaining('ZZZZZ') })
  })

  it('alert_list forwards the status filter', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['alert_list'] as { execute: (args: { status: 'active' }) => Promise<unknown> })
      .execute({ status: 'active' })
    expect(alertsMock.listAlerts).toHaveBeenCalledWith({ status: 'active' })
    expect(out).toMatchObject({ alerts: [] })
  })

  it('alert_cancel reports a missing alert as an error', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['alert_cancel'] as { execute: (args: { id: string }) => Promise<unknown> })
      .execute({ id: 'nope' })
    expect(alertsMock.cancelAlert).toHaveBeenCalledWith('nope')
    expect(out).toMatchObject({ error: 'alert not found', id: 'nope' })
  })
})
