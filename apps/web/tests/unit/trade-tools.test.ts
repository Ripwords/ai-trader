import { describe, expect, it } from 'vitest'
import { makeTradeTools } from '../../server/mastra/tools/trade'

const fakeClient = {
  async listAccounts() {
    return [{ acc_id: 12345, trd_env: 'SIMULATE' as const, acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'OWNER' }]
  },
  async getPortfolio(_args: { acc_id: number }) {
    return { cash: 10000, market_val: 5000, total_assets: 15000, positions: [{ code: 'US.NVDA', qty: 10, cost_price: 100, current_price: 110, market_val: 1100, pl_val: 100, pl_ratio: 0.10 }] }
  },
  async listOrders(_args: { acc_id: number }) {
    return [{ order_id: 'ord-1', code: 'US.NVDA', side: 'BUY' as const, qty: 10, price: 100, status: 'FILLED_ALL', created_at: '2026-05-08T09:30:00' }]
  },
  async listFills(_args: { acc_id: number }) {
    return []
  },
}

describe('trade tools', () => {
  it('accounts returns wrapped list', async () => {
    const t = makeTradeTools(fakeClient as any)
    const out = await t.accounts.execute({} as any)
    expect(out.accounts[0].acc_id).toBe(12345)
  })
  it('portfolio returns positions', async () => {
    const t = makeTradeTools(fakeClient as any)
    const out = await t.portfolio.execute({ acc_id: 12345, trd_env: 'SIMULATE' } as any)
    expect(out.positions[0].code).toBe('US.NVDA')
  })
  it('orders returns wrapped list', async () => {
    const t = makeTradeTools(fakeClient as any)
    const out = await t.orders.execute({ acc_id: 12345, trd_env: 'SIMULATE' } as any)
    expect(out.orders[0].order_id).toBe('ord-1')
  })
})
