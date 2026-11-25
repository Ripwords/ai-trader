import { describe, expect, it, vi } from 'vitest'
import { accountLabel, loadOpenOrders, paperAccountFor, tradableAccounts } from '../../server/lib/open-orders'
import type { Account, Order } from '../../server/llm/http'

const acct = (over: Partial<Account>): Account => ({
  acc_id: '1', trd_env: 'SIMULATE', acc_type: 'CASH', card_num: null, security_firm: 'FUTUMY', trdmarket_auth: ['US'], acc_role: 'MASTER', ...over,
})
const order = (over: Partial<Order>): Order => ({
  order_id: 'O1', code: 'US.NVDA', side: 'BUY', qty: 1, price: 100, status: 'SUBMITTED', created_at: '2026-11-25 10:00:00', ...over,
})

describe('tradableAccounts', () => {
  it('leaves out IPO accounts', () => {
    expect(tradableAccounts([acct({ acc_id: '1' }), acct({ acc_id: '2', acc_role: 'IPO' })]).map(a => a.acc_id)).toEqual(['1'])
  })
})

describe('accountLabel', () => {
  it('names the environment, markets and the card tail, not the account id', () => {
    expect(accountLabel(acct({ trd_env: 'REAL', card_num: '1001234567890123' }))).toBe('Live US ··0123')
    expect(accountLabel(acct({ trd_env: 'SIMULATE', trdmarket_auth: ['HK'] }))).toBe('Paper HK')
  })
  it('skips a card moomoo reports as N/A and a long market list', () => {
    expect(accountLabel(acct({ trd_env: 'SIMULATE', trdmarket_auth: ['US'], card_num: 'N/A' }))).toBe('Paper US')
    expect(accountLabel(acct({ trd_env: 'REAL', trdmarket_auth: ['HK', 'US', 'HKCC', 'SG', 'MY'], card_num: '1001234567897296' })))
      .toBe('Live ··7296')
  })
})

describe('loadOpenOrders', () => {
  it('asks every tradable account for its active orders and tags each order with its account', async () => {
    const listOrders = vi.fn(async ({ acc_id }: { acc_id: string }) => [order({ order_id: `O-${acc_id}` })])
    const out = await loadOpenOrders({
      listAccounts: async () => [acct({ acc_id: '1' }), acct({ acc_id: '2', trd_env: 'REAL' }), acct({ acc_id: '3', acc_role: 'IPO' })],
      listOrders,
    })
    expect(listOrders).toHaveBeenCalledWith({ acc_id: '1', trd_env: 'SIMULATE', active_only: true })
    expect(listOrders).toHaveBeenCalledWith({ acc_id: '2', trd_env: 'REAL', active_only: true })
    expect(listOrders).toHaveBeenCalledTimes(2)
    expect(out.orders.map(o => [o.order_id, o.acc_id, o.trd_env])).toEqual([['O-1', '1', 'SIMULATE'], ['O-2', '2', 'REAL']])
    expect(out.failures).toEqual([])
    expect(out.accounts.map(a => a.acc_id)).toEqual(['1', '2'])
  })

  it('reports an account it could not read instead of showing it as empty', async () => {
    const out = await loadOpenOrders({
      listAccounts: async () => [acct({ acc_id: '1' }), acct({ acc_id: '2', trd_env: 'REAL' })],
      listOrders: async ({ acc_id }) => {
        if (acc_id === '2') throw Object.assign(new Error('x'), { data: { detail: 'OpenD unreachable' } })
        return []
      },
    })
    expect(out.failures).toEqual([{ acc_id: '2', trd_env: 'REAL', label: 'Live US', message: 'OpenD unreachable' }])
  })

  it('puts the newest order first', async () => {
    const out = await loadOpenOrders({
      listAccounts: async () => [acct({})],
      listOrders: async () => [order({ order_id: 'old', created_at: '2026-11-24 09:00:00' }), order({ order_id: 'new', created_at: '2026-11-25 09:00:00' })],
    })
    expect(out.orders.map(o => o.order_id)).toEqual(['new', 'old'])
  })
})

describe('paperAccountFor', () => {
  const hk = acct({ acc_id: 'hk', trd_env: 'SIMULATE', trdmarket_auth: ['HK'] })
  const us = acct({ acc_id: 'us', trd_env: 'SIMULATE', trdmarket_auth: ['US'] })
  const live = acct({ acc_id: 'live', trd_env: 'REAL', trdmarket_auth: ['US'] })
  it('picks the paper account that trades the symbol\'s market', () => {
    expect(paperAccountFor([live, hk, us], 'US.NVDA')?.acc_id).toBe('us')
    expect(paperAccountFor([live, hk, us], 'HK.00700')?.acc_id).toBe('hk')
  })
  it('falls back to the first paper account, and finds none without one', () => {
    expect(paperAccountFor([live, hk, us], 'SG.D05')?.acc_id).toBe('hk')
    expect(paperAccountFor([live], 'US.NVDA')).toBeUndefined()
  })
})
