import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../server/llm/http'
import { containsPhrase, makeTools } from '../../server/llm/tools'
import { resetLiveConfirmations } from '../../server/llm/live-confirmations'

beforeEach(() => resetLiveConfirmations())

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
  checkNewAlert: vi.fn(async (): Promise<string | null> => null),
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
  cancelAlert: vi.fn(async (): Promise<{ error: string }> => ({ error: 'alert not found' })),
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

vi.mock('../../server/lib/alert-quote', () => ({ checkNewAlert: alertsMock.checkNewAlert }))
vi.mock('../../server/lib/alerts', () => ({
  createAlert: alertsMock.createAlert,
  listAlerts: alertsMock.listAlerts,
  cancelAlert: alertsMock.cancelAlert,
}))

const yahooBarsMock = vi.hoisted(() => ({
  getDailyBars: vi.fn(async () => Array.from({ length: 260 }, (_, i) => ({
    time: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1000 + i,
  }))),
}))

vi.mock('../../server/lib/yahoo', () => ({
  resolveSymbol: alertsMock.resolveSymbolMock,
  getDailyBars: yahooBarsMock.getDailyBars,
  toYahooSymbol: (s: string) => s.replace(/^US\./, ''),
  getFxRate: async (from: string) => (from === 'USD' ? 4.5 : 1),
  getYahooQuote: async (): Promise<null> => null,
}))

const remindersMock = vi.hoisted(() => ({
  createReminder: vi.fn(async (input: { dueAt: Date; message: string; symbol: string | null }) => ({
    id: 'rem-1',
    createdAt: '2026-10-17T00:00:00.000Z',
    dueAt: input.dueAt.toISOString(),
    message: input.message,
    symbol: input.symbol,
    status: 'scheduled',
    sentAt: null,
  })),
  listReminders: vi.fn(async () => [{
    id: 'rem-1', createdAt: '2026-10-17T00:00:00.000Z', dueAt: '2099-10-17T01:00:00.000Z', message: 'm', symbol: null, status: 'scheduled', sentAt: null,
  }]),
  cancelReminder: vi.fn(async (): Promise<null> => null),
  settings: { email: null as string | null, timezone: 'Asia/Kuala_Lumpur', priceAlerts: true, reminders: true, researchRuns: true, chatReplies: true },
  countPushSubscriptions: vi.fn(async () => 2),
}))

vi.mock('../../server/lib/reminders', () => ({
  createReminder: remindersMock.createReminder,
  listReminders: remindersMock.listReminders,
  cancelReminder: remindersMock.cancelReminder,
}))

vi.mock('../../server/lib/notification-settings', () => ({
  getNotificationSettings: async () => remindersMock.settings,
}))

vi.mock('../../server/lib/push/subscriptions', () => ({
  countPushSubscriptions: remindersMock.countPushSubscriptions,
}))

const planningMock = vi.hoisted(() => {
  const portfolio = {
    net_worth_total: 100_000, net_worth_currency: 'MYR', cash_total: 0, positions_value: 100_000, total_pnl_pct: 0,
    accounts: [], moomoo_paper: [], ghostfolio_status: 'ok', moomoo_status: 'ok', fetched_at: '2026-11-22T01:00:00.000Z',
    moomoo_live: [{ symbol: 'US.VOO', quantity: 100, market_value: 20_000, pnl_pct: 12, account_id: '1', currency: 'USD' }],
    moomoo_live_cash: { USD: 150 },
    positions: [
      { symbol: 'MMF', name: 'MMF', quantity: 10_000, market_price: 1, market_value: 10_000, investment: 10_000, allocation_pct: 10, pnl_pct: 0, asset_class: 'LIQUIDITY', data_source: null, sectors: [], currency: 'MYR' },
      { symbol: 'VOO', name: 'VOO', quantity: 100, market_price: 900, market_value: 90_000, investment: 80_000, allocation_pct: 90, pnl_pct: 12, asset_class: 'EQUITY', data_source: null, sectors: [], currency: 'USD' },
    ],
  }
  const withPension = {
    ...portfolio,
    net_worth_total: 140_000,
    positions_value: 140_000,
    positions: [
      ...portfolio.positions,
      { symbol: 'GF_KWSP', name: 'KWSP', quantity: 1, market_price: 40_000, market_value: 40_000, investment: 30_000, allocation_pct: 28.57, pnl_pct: 33, asset_class: 'FIXED_INCOME', data_source: 'MANUAL', sectors: [], currency: 'MYR' },
    ],
  }
  return {
    portfolio,
    withPension,
    current: portfolio as typeof portfolio,
    stored: { target_model: [{ key: 'cash', label: 'Cash', target_pct: 10 }, { key: 'equity', label: 'Equity', target_pct: 90 }, { key: 'bond', label: 'Bonds', target_pct: 0 }], monthly_expenses: 3000, emergency_fund_months: 6, monthly_contribution: 1000, liabilities: [], cashflow_items: [], locked_symbols: ['GF_KWSP'] } as Record<string, unknown>,
    save: vi.fn(async (input: unknown) => input),
  }
})

vi.mock('../../server/lib/planning-settings', () => ({
  getPlanningSettings: async () => planningMock.stored,
  savePlanningSettings: planningMock.save,
}))

vi.mock('../../server/lib/portfolio-cache', () => ({
  getFullPortfolioCached: async () => planningMock.current,
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
    valuationScreen: vi.fn(async () => ({
      rows: [
        { symbol: 'US.NVDA', fair_value: '150.5', current_price: '100', margin_of_safety_pct: '0.335', data_quality: 'full', veto: false, error: null },
        { symbol: 'US.TSLA', fair_value: null, current_price: null, margin_of_safety_pct: null, data_quality: null, veto: null, error: 'yahoo down' },
      ],
      total_symbols: 2,
      truncated: false,
      source: 'watchlist' as const,
      warnings: [],
    })),
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
      'earnings_call_transcript',
      'earnings_release',
      'earnings_surprise',
      'estimate_revisions',
      'holdings_context',
      'investment_performance',
      'investment_portfolio',
      'investment_research',
      'market_kline',
      'market_order_book',
      'market_snapshot',
      'news_pulse',
      'planning_get',
      'planning_update',
      'portfolio_mpt_analysis',
      'portfolio_performance',
      'portfolio_rebalance_plan',
      'reminder_cancel',
      'reminder_create',
      'reminder_list',
      'research_get',
      'research_start',
      'search_news',
      'search_web',
      'technical_analysis',
      'thesis_tracker',
      'trade_account_overview',
      'trade_accounts',
      'trade_cancel_order',
      'trade_fills',
      'trade_modify_order',
      'trade_orders',
      'trade_place_order',
      'trade_portfolio',
      'usage_summary',
      'value_screen',
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

  it('blocks a live order whose price is only a prefix of the confirmed one (typed @ 150, sent @ 15)', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient, {
      latestUserText: 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 150',
    })
    await expect(
      (tools['trade_place_order'] as { execute: (args: Record<string, unknown>) => Promise<unknown> }).execute({
        code: 'US.NVDA', side: 'BUY', qty: 1, price: 15, order_type: 'NORMAL', trd_env: 'REAL',
        live_confirmation: 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 15',
      }),
    ).rejects.toThrow(/Live trade blocked/)
    expect(c.placeOrder).not.toHaveBeenCalled()
  })

  it('blocks a live cancel of order 12 when the user confirmed order 1234', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient, { latestUserText: 'LIVE CANCEL 1234' })
    await expect(
      (tools['trade_cancel_order'] as { execute: (args: Record<string, unknown>) => Promise<unknown> }).execute({
        order_id: '12', trd_env: 'REAL', live_confirmation: 'LIVE CANCEL 12',
      }),
    ).rejects.toThrow(/Live trade blocked/)
  })

  it('blocks a live modify that drops a field the user confirmed (typed PRICE 15 QTY 10, sent PRICE 15)', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient, { latestUserText: 'LIVE MODIFY 77 PRICE 15 QTY 10' })
    await expect(
      (tools['trade_modify_order'] as { execute: (args: Record<string, unknown>) => Promise<unknown> }).execute({
        order_id: '77', price: 15, trd_env: 'REAL', live_confirmation: 'LIVE MODIFY 77 PRICE 15',
      }),
    ).rejects.toThrow(/Live trade blocked/)
  })

  it('places a confirmed live order once, even when the model calls the tool twice in that turn', async () => {
    const c = fakeClient()
    const phrase = 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 100'
    const tools = makeTools(c as unknown as ApiClient, { latestUserText: phrase, latestUserMessageId: 'm1' })
    const place = (tools['trade_place_order'] as { execute: (args: Record<string, unknown>) => Promise<unknown> }).execute
    const args = { code: 'US.NVDA', side: 'BUY', qty: 1, price: 100, order_type: 'NORMAL', trd_env: 'REAL', live_confirmation: phrase }
    const results = await Promise.allSettled([place(args), place(args)])
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(c.placeOrder).toHaveBeenCalledTimes(1)
  })

  it('does not place the order again when the reply is retried with the same message', async () => {
    const phrase = 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 100'
    const args = { code: 'US.NVDA', side: 'BUY', qty: 1, price: 100, order_type: 'NORMAL', trd_env: 'REAL', live_confirmation: phrase }
    const first = fakeClient()
    await (makeTools(first as unknown as ApiClient, { latestUserText: phrase, latestUserMessageId: 'm1' })['trade_place_order'] as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute(args)
    const retry = fakeClient()
    await expect(
      (makeTools(retry as unknown as ApiClient, { latestUserText: phrase, latestUserMessageId: 'm1' })['trade_place_order'] as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute(args),
    ).rejects.toThrow(/already used/)
    expect(retry.placeOrder).not.toHaveBeenCalled()
  })

  it('places the same order again when the user types the phrase in a new message', async () => {
    const phrase = 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 100'
    const args = { code: 'US.NVDA', side: 'BUY', qty: 1, price: 100, order_type: 'NORMAL', trd_env: 'REAL', live_confirmation: phrase }
    const c = fakeClient()
    await (makeTools(c as unknown as ApiClient, { latestUserText: phrase, latestUserMessageId: 'm1' })['trade_place_order'] as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute(args)
    await (makeTools(c as unknown as ApiClient, { latestUserText: phrase, latestUserMessageId: 'm2' })['trade_place_order'] as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute(args)
    expect(c.placeOrder).toHaveBeenCalledTimes(2)
  })

  it('lets the phrase be used again after the api refused the order outright', async () => {
    const phrase = 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 100'
    const args = { code: 'US.NVDA', side: 'BUY', qty: 1, price: 100, order_type: 'NORMAL', trd_env: 'REAL', live_confirmation: phrase }
    const c = fakeClient()
    c.placeOrder.mockRejectedValueOnce(Object.assign(new Error('cap'), { status: 409 }))
    const place = (makeTools(c as unknown as ApiClient, { latestUserText: phrase, latestUserMessageId: 'm1' })['trade_place_order'] as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute
    await expect(place(args)).rejects.toThrow(/cap/)
    await place(args)
    expect(c.placeOrder).toHaveBeenCalledTimes(2)
  })

  it('keeps the phrase used after a timeout, because the order may have gone through', async () => {
    const phrase = 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 100'
    const args = { code: 'US.NVDA', side: 'BUY', qty: 1, price: 100, order_type: 'NORMAL', trd_env: 'REAL', live_confirmation: phrase }
    const c = fakeClient()
    c.placeOrder.mockRejectedValueOnce(new Error('request timed out'))
    const place = (makeTools(c as unknown as ApiClient, { latestUserText: phrase, latestUserMessageId: 'm1' })['trade_place_order'] as { execute: (a: Record<string, unknown>) => Promise<unknown> }).execute
    await expect(place(args)).rejects.toThrow(/timed out/)
    await expect(place(args)).rejects.toThrow(/already used/)
    expect(c.placeOrder).toHaveBeenCalledTimes(1)
  })

  it('does not read a thousands separator as the end of the confirmed price (typed @ 1,000, sent @ 1)', () => {
    expect(containsPhrase('LIVE PLACE SELL 5 US.NVDA NORMAL @ 1,000', 'LIVE PLACE SELL 5 US.NVDA NORMAL @ 1')).toBe(false)
    expect(containsPhrase('LIVE PLACE SELL 5 US.NVDA NORMAL @ 1, THANKS', 'LIVE PLACE SELL 5 US.NVDA NORMAL @ 1')).toBe(true)
  })

  it('still accepts the confirmed phrase at the end of a sentence', async () => {
    const c = fakeClient()
    const phrase = 'LIVE PLACE BUY 1 US.NVDA NORMAL @ 100'
    const tools = makeTools(c as unknown as ApiClient, { latestUserText: `ok, ${phrase}.` })
    await (tools['trade_place_order'] as { execute: (args: Record<string, unknown>) => Promise<unknown> }).execute({
      code: 'US.NVDA', side: 'BUY', qty: 1, price: 100, order_type: 'NORMAL', trd_env: 'REAL', live_confirmation: phrase,
    })
    expect(c.placeOrder).toHaveBeenCalled()
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

  it('trade_orders lists today by default and switches to the history query when a range is given', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    type Exec = { execute: (args: { acc_id: string; trd_env: 'SIMULATE' | 'REAL'; start?: string; end?: string; code?: string }) => Promise<unknown> }
    const today = await (tools['trade_orders'] as Exec).execute({ acc_id: '1', trd_env: 'REAL' })
    expect(c.listOrders).toHaveBeenCalledWith({ acc_id: '1', trd_env: 'REAL' })
    expect(c.listHistoryOrders).not.toHaveBeenCalled()
    expect((today as { orders: unknown[] }).orders).toEqual([])

    const out = await (tools['trade_orders'] as Exec).execute({ acc_id: '1', trd_env: 'SIMULATE', start: '2026-06-18', end: '2026-07-18' })
    expect(c.listHistoryOrders).toHaveBeenCalledWith({
      acc_id: '1', trd_env: 'SIMULATE', start: '2026-06-18', end: '2026-07-18',
    })
    expect((out as { orders: unknown[] }).orders).toHaveLength(1)
  })

  it('trade_fills treats a symbol filter as a history query', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['trade_fills'] as { execute: (args: {
      acc_id: string
      trd_env: 'REAL'
      code: string
    }) => Promise<unknown> }).execute({ acc_id: '1', trd_env: 'REAL', code: 'US.NVDA' })
    expect(c.listHistoryFills).toHaveBeenCalledWith({
      acc_id: '1', trd_env: 'REAL', code: 'US.NVDA',
    })
    expect(c.listFills).not.toHaveBeenCalled()
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

  it('alert_create refuses an alert whose condition already holds, so the model can flip the direction', async () => {
    alertsMock.createAlert.mockClear()
    alertsMock.checkNewAlert.mockResolvedValueOnce('US.NVDA is already at 180.00, at or above 150.00, so the alert would fire at once. Use price_below to be told when it falls to 150.00.')
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['alert_create'] as { execute: (args: {
      symbol: string
      kind: 'price_above'
      threshold: number
    }) => Promise<unknown> }).execute({ symbol: 'NVDA', kind: 'price_above', threshold: 150 })
    expect(alertsMock.checkNewAlert).toHaveBeenCalledWith('US.NVDA', { kind: 'price_above', threshold: 150 })
    expect(out).toEqual({ error: expect.stringContaining('price_below') })
    expect(alertsMock.createAlert).not.toHaveBeenCalled()
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

  it('value_screen forwards optional symbols to client.valuationScreen', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['value_screen'] as { execute: (args: { symbols?: string[] }) => Promise<unknown> })
      .execute({ symbols: ['US.NVDA', 'US.TSLA'] })
    expect(c.valuationScreen).toHaveBeenCalledWith({ symbols: ['US.NVDA', 'US.TSLA'] })
    expect((out as { rows: unknown[] }).rows).toHaveLength(2)
    expect((out as { rows: { symbol: string }[] }).rows[0].symbol).toBe('US.NVDA')
  })

  it('value_screen defaults to the watchlist when no symbols are given', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    await (tools['value_screen'] as { execute: (args: { symbols?: string[] }) => Promise<unknown> }).execute({})
    expect(c.valuationScreen).toHaveBeenCalledWith({})
  })

  it('technical_analysis resolves the symbol, fetches daily bars, and returns the snapshot + signals', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['technical_analysis'] as { execute: (args: { symbol: string; lookback_days: number }) => Promise<unknown> })
      .execute({ symbol: 'NVDA', lookback_days: 365 })

    expect(alertsMock.resolveSymbolMock).toHaveBeenCalledWith('NVDA')
    // 365 calendar days ~ 252 trading bars, floored at 250 so SMA200 resolves
    expect(yahooBarsMock.getDailyBars).toHaveBeenCalledWith('US.NVDA', 252)
    const result = out as { symbol: string; name: string; bar_count: number; snapshot: { trend: string; signals: unknown[]; rsi14: number } }
    expect(result.symbol).toBe('US.NVDA')
    expect(result.bar_count).toBe(260)
    expect(result.snapshot.trend).toBe('up')
    expect(Array.isArray(result.snapshot.signals)).toBe(true)
    expect(result.snapshot.signals.length).toBeGreaterThan(0)
  })

  it('technical_analysis surfaces an unresolved symbol instead of guessing', async () => {
    yahooBarsMock.getDailyBars.mockClear()
    alertsMock.resolveSymbolMock.mockResolvedValueOnce({
      status: 'not_found',
    } as unknown as Awaited<ReturnType<typeof alertsMock.resolveSymbolMock>>)
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['technical_analysis'] as { execute: (args: { symbol: string; lookback_days: number }) => Promise<unknown> })
      .execute({ symbol: 'ZZZZZ', lookback_days: 365 })
    expect(out).toMatchObject({ error: expect.stringContaining('ZZZZZ') })
    expect(yahooBarsMock.getDailyBars).not.toHaveBeenCalled()
  })

  it('technical_analysis reports empty bar history as an error', async () => {
    yahooBarsMock.getDailyBars.mockResolvedValueOnce([])
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['technical_analysis'] as { execute: (args: { symbol: string; lookback_days: number }) => Promise<unknown> })
      .execute({ symbol: 'NVDA', lookback_days: 365 })
    expect(out).toMatchObject({ error: expect.stringContaining('no daily bars') })
  })

  it('alert_cancel reports a missing alert as an error', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['alert_cancel'] as { execute: (args: { id: string }) => Promise<unknown> })
      .execute({ id: 'nope' })
    expect(alertsMock.cancelAlert).toHaveBeenCalledWith('nope')
    expect(out).toMatchObject({ error: 'alert not found', id: 'nope' })
  })
  it('reminder_create stores the due time in UTC and reports it back in the settings timezone', async () => {
    remindersMock.createReminder.mockClear()
    vi.stubEnv('VAPID_PUBLIC_KEY', 'pub')
    vi.stubEnv('VAPID_PRIVATE_KEY', 'priv')
    vi.stubEnv('VAPID_SUBJECT', 'mailto:me@example.com')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2099-10-16T00:00:00.000Z'))
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['reminder_create'] as { execute: (args: { due_at: string; message: string; symbol?: string }) => Promise<unknown> })
      .execute({ due_at: '2099-10-17T09:00:00+08:00', message: 'Check NVDA earnings', symbol: 'NVDA' })
      .finally(() => vi.useRealTimers())

    expect(remindersMock.createReminder).toHaveBeenCalledWith({
      dueAt: new Date('2099-10-17T01:00:00.000Z'),
      message: 'Check NVDA earnings',
      symbol: 'US.NVDA',
    })
    expect(out).toMatchObject({
      reminder: { id: 'rem-1', status: 'scheduled' },
      timezone: 'Asia/Kuala_Lumpur',
      delivery: { email: false, pushDevices: 2 },
    })
    expect((out as { dueAtLocal: string }).dueAtLocal).toContain('09:00')
    vi.unstubAllEnvs()
  })

  it('reminder_create does not promise an email or push the server has no keys to send', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    vi.stubEnv('VAPID_PRIVATE_KEY', '')
    remindersMock.settings.email = 'me@example.com'
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['reminder_create'] as { execute: (args: { due_at: string; message: string }) => Promise<unknown> })
      .execute({ due_at: new Date(Date.now() + 86_400_000).toISOString(), message: 'x' })
      .finally(() => { remindersMock.settings.email = null; vi.unstubAllEnvs() })
    expect(out).toMatchObject({ delivery: { email: false, pushDevices: 0 } })
  })

  it('reminder_create refuses a past due time or a time without an offset', async () => {
    remindersMock.createReminder.mockClear()
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const create = tools['reminder_create'] as { execute: (args: { due_at: string; message: string }) => Promise<unknown> }
    expect(await create.execute({ due_at: '2020-01-01T09:00:00+08:00', message: 'late' })).toMatchObject({ error: expect.stringContaining('past') })
    expect(await create.execute({ due_at: '2099-01-01 09:00', message: 'no offset' })).toMatchObject({ error: expect.any(String) })
    expect(remindersMock.createReminder).not.toHaveBeenCalled()
  })

  it('reminder_list shows due times in the settings timezone', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['reminder_list'] as { execute: (args: { status: 'scheduled' }) => Promise<unknown> })
      .execute({ status: 'scheduled' })
    expect(remindersMock.listReminders).toHaveBeenCalledWith({ status: 'scheduled' })
    expect(out).toMatchObject({ timezone: 'Asia/Kuala_Lumpur', reminders: [{ id: 'rem-1', dueAtLocal: expect.stringContaining('09:00') }] })
  })

  it('reminder_cancel reports a missing reminder as an error', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['reminder_cancel'] as { execute: (args: { id: string }) => Promise<unknown> })
      .execute({ id: 'nope' })
    expect(out).toMatchObject({ error: expect.stringContaining('not found'), id: 'nope' })
  })

  it('planning_get returns the plan with the settings ids the update tool needs', async () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['planning_get'] as { execute: (args: { force: boolean }) => Promise<unknown> }).execute({ force: false })
    expect(out).toMatchObject({
      inputs: { monthly_expenses: 3000, monthly_contribution: 1000, cashflow_items: [] },
      allocation_rows: expect.arrayContaining([expect.objectContaining({ key: 'equity', actual_pct: 90 })]),
    })
    expect(out).not.toHaveProperty('settings')
    expect(out).not.toHaveProperty('summary')
  })

  it('planning_get keeps a locked pension out of the allocation and reports it once', async () => {
    planningMock.current = planningMock.withPension
    try {
      const tools = makeTools(fakeClient() as unknown as ApiClient)
      const out = await (tools['planning_get'] as { execute: (args: { force: boolean }) => Promise<unknown> }).execute({ force: false })
      expect(out).toMatchObject({
        investable_total: 100_000,
        locked: { total: 40_000, holdings: [{ symbol: 'GF_KWSP', name: 'KWSP', value: 40_000 }] },
        allocation_rows: expect.arrayContaining([expect.objectContaining({ key: 'equity', actual_pct: 90 })]),
        concentration: { top_position: { symbol: 'VOO', allocation_pct: 90 } },
      })
      const text = JSON.stringify(out)
      expect(text.match(/GF_KWSP/g)).toHaveLength(2)
      expect(text).not.toMatch(/critical|alert|behind|severity/i)
    } finally {
      planningMock.current = planningMock.portfolio
    }
  })

  it('planning_update locks a holding the owner names', async () => {
    planningMock.save.mockClear()
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['planning_update'] as { execute: (args: unknown) => Promise<unknown> })
      .execute({ locked_symbols: ['GF_KWSP', 'VOO'] })
    expect(planningMock.save).toHaveBeenCalledWith(expect.objectContaining({ locked_symbols: ['GF_KWSP', 'VOO'] }))
    expect(out).toMatchObject({ changes: [{ field: 'locked_symbols', before: ['GF_KWSP'], after: ['GF_KWSP', 'VOO'] }] })
  })

  it('planning_update saves the patched settings and returns what changed, so the user can ask to undo it', async () => {
    planningMock.save.mockClear()
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['planning_update'] as { execute: (args: unknown) => Promise<unknown> })
      .execute({ target_model: [{ key: 'equity', target_pct: 70 }, { key: 'bond', target_pct: 20 }] })
    expect(planningMock.save).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({
      saved: true,
      changes: expect.arrayContaining([{ field: 'target_model.equity', before: 90, after: 70 }]),
      allocation_rows: expect.any(Array),
    })
  })

  it('planning_update saves nothing when the target model would not total 100%', async () => {
    planningMock.save.mockClear()
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['planning_update'] as { execute: (args: unknown) => Promise<unknown> })
      .execute({ target_model: [{ key: 'bond', target_pct: 20 }] })
    expect(planningMock.save).not.toHaveBeenCalled()
    expect(out).toMatchObject({ error: expect.stringContaining('120%') })
  })

  it('portfolio_rebalance_plan proposes trades against the saved target without placing any', async () => {
    planningMock.stored = { ...planningMock.stored, target_model: [{ key: 'cash', target_pct: 10 }, { key: 'equity', target_pct: 70 }, { key: 'bond', target_pct: 20 }] }
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['portfolio_rebalance_plan'] as { execute: (args: unknown) => Promise<unknown> })
      .execute({ mode: 'full' })
    expect(out).toMatchObject({
      trades: [{ symbol: 'VOO', side: 'sell', shares: 4, price: 900, currency: 'USD', fx_rate: 4.5, value_native: 3_600, value: 16_200 }],
      buckets: expect.arrayContaining([{ key: 'bond', actual_pct: 0, target_pct: 20, planned: 20_000, traded: 0, instruments: 0 }]),
      broker_cash: { USD: 150 },
      fetched_at: '2026-11-22T01:00:00.000Z',
    })
    expect(out).not.toHaveProperty('allocation_rows')
    expect(c.placeOrder).not.toHaveBeenCalled()
  })

  it('portfolio_rebalance_plan spends the saved monthly contribution when no amount is given', async () => {
    planningMock.stored = { ...planningMock.stored, monthly_contribution: 5000, target_model: [{ key: 'cash', target_pct: 5 }, { key: 'equity', target_pct: 95 }, { key: 'bond', target_pct: 0 }] }
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    const out = await (tools['portfolio_rebalance_plan'] as { execute: (args: unknown) => Promise<unknown> })
      .execute({ mode: 'contribute_only' })
    expect(out).toMatchObject({ contribution: 5000, unallocated: 950, trades: [expect.objectContaining({ symbol: 'VOO', side: 'buy', shares: 1, value: 4_050 })] })
  })

  it('portfolio_rebalance_plan reports a candidate it cannot place instead of proposing it', async () => {
    planningMock.current = planningMock.withPension
    try {
      const tools = makeTools(fakeClient() as unknown as ApiClient)
      const out = await (tools['portfolio_rebalance_plan'] as { execute: (args: unknown) => Promise<unknown> })
        .execute({ mode: 'contribute_only', contribution: 5000, candidates: [{ symbol: 'GF_KWSP' }] })
      expect(out).toMatchObject({ skipped: expect.arrayContaining([{ symbol: 'GF_KWSP', reason: 'locked' }]) })
      expect(JSON.stringify((out as { trades: unknown[] }).trades)).not.toContain('GF_KWSP')
    } finally {
      planningMock.current = planningMock.portfolio
    }
  })
})
