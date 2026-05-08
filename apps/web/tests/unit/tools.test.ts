import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../server/llm/http'
import { makeTools } from '../../server/llm/tools'

// Stand-in for ApiClient — only the methods our tools call.
function fakeClient() {
  return {
    getKline: vi.fn(async () => ({ code: 'US.NVDA', ktype: '1d', bars: [{ time: 't', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, turnover: 15 }] })),
    getSnapshot: vi.fn(async () => ({ code: 'US.NVDA', name: 'NVIDIA', lastPrice: 100, openPrice: 99, highPrice: 101, lowPrice: 98, prevClosePrice: 99, changeRate: 0.01, volume: 1000, turnover: 100000, updateTime: 't' })),
    listWatchlist: vi.fn(async () => [{ code: 'US.NVDA', name: 'NVIDIA', group: 'All' }]),
    addWatchlistItem: vi.fn(async () => ({ status: 'ok' })),
    removeWatchlistItem: vi.fn(async () => ({ status: 'ok' })),
    listAccounts: vi.fn(async () => [{ acc_id: 1, trd_env: 'SIMULATE' as const, acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'OWNER' }]),
    getPortfolio: vi.fn(async () => ({ cash: 10000, market_val: 5000, total_assets: 15000, positions: [] })),
    listOrders: vi.fn(async () => []),
    listFills: vi.fn(async () => []),
  }
}

describe('tool catalogue', () => {
  it('exposes the expected tool names', () => {
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    expect(Object.keys(tools).sort()).toEqual([
      'market_kline',
      'market_snapshot',
      'search_news',
      'search_web',
      'trade_accounts',
      'trade_fills',
      'trade_orders',
      'trade_portfolio',
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

  it('watchlist.list wraps result under {items}', async () => {
    const c = fakeClient()
    const tools = makeTools(c as unknown as ApiClient)
    const out = await (tools['watchlist_list'] as { execute: (args: { group: string }) => Promise<unknown> }).execute({ group: 'All' })
    expect((out as { items: unknown[] }).items.length).toBe(1)
  })

  it('search.web throws without TAVILY_API_KEY', async () => {
    delete process.env.TAVILY_API_KEY
    const tools = makeTools(fakeClient() as unknown as ApiClient)
    await expect(
      (tools['search_web'] as { execute: (args: { query: string; maxResults: number }) => Promise<unknown> }).execute({ query: 'x', maxResults: 3 }),
    ).rejects.toThrow(/TAVILY_API_KEY/)
  })
})
