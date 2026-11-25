import { describe, expect, it, vi } from 'vitest'
import {
  approveProposal,
  createProposal,
  editProposal,
  placeNow,
  resolveSubmitting,
  STUCK_AFTER_MS,
  type OrderPlacer,
  type Proposal,
  type ProposalStore,
} from '../../server/lib/order-proposals'
import type { Account, Order, PlaceOrderResult } from '../../server/llm/http'

const ID = '11111111-2222-3333-4444-555555555555'

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: ID,
    createdAt: '2026-11-25T10:00:00Z',
    expiresAt: '2026-11-26T10:00:00Z',
    source: 'chat',
    decisionId: null,
    algoStrategyId: null,
    accId: '9001',
    trdEnv: 'SIMULATE',
    symbol: 'US.NVDA',
    side: 'BUY',
    qty: 3,
    orderType: 'NORMAL',
    price: 100,
    triggerPrice: null,
    trailType: null,
    trailValue: null,
    trailSpread: null,
    timeInForce: 'DAY',
    session: 'RTH',
    rationale: null,
    status: 'pending',
    moomooOrderId: null,
    error: null,
    decidedAt: null,
    claimedAt: null,
    ...over,
  }
}

/** One row, kept in memory, with the conditional claim the Drizzle store does in SQL. */
function memoryStore(row: Proposal | null, now = new Date('2026-11-25T12:00:00Z')) {
  let current = row ? { ...row } : null
  const store: ProposalStore = {
    async insert(values) {
      current = proposal({ ...values, id: ID, status: 'pending' })
      return current
    },
    async get() { return current ? { ...current } : null },
    async claim() {
      if (!current || current.status !== 'pending' || new Date(current.expiresAt) <= now) return null
      current = { ...current, status: 'submitting', claimedAt: now }
      return { ...current }
    },
    async finish(_id, patch) {
      if (!current) return null
      current = { ...current, ...patch }
      return { ...current }
    },
    async updatePending(_id, patch) {
      if (!current || current.status !== 'pending') return null
      current = { ...current, ...patch }
      return { ...current }
    },
  }
  return { store, row: () => current }
}

function placed(over: Partial<PlaceOrderResult> = {}): PlaceOrderResult {
  return { order_id: 'OID-1', code: 'US.NVDA', side: 'BUY', qty: 3, price: 100, status: 'SUBMITTED', trd_env: 'SIMULATE', acc_id: '9001', ...over }
}

function client(over: Partial<OrderPlacer> = {}): OrderPlacer {
  return {
    placeOrder: vi.fn(async () => placed()),
    listOrders: vi.fn(async (): Promise<Order[]> => []),
    listAccounts: vi.fn(async (): Promise<Account[]> => []),
    listHistoryOrders: vi.fn(async (): Promise<Order[]> => []),
    ...over,
  }
}

function httpError(status: number | undefined, detail: string) {
  return Object.assign(new Error(detail), { status, data: { detail } })
}

describe('approveProposal', () => {
  it('places the order with the proposal id in the remark and marks it submitted', async () => {
    const { store, row } = memoryStore(proposal())
    const c = client()
    const recordPaper = vi.fn(async () => true)
    const out = await approveProposal(ID, { store, client: c, recordPaper })
    expect(c.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      code: 'US.NVDA', side: 'BUY', qty: 3, price: 100, order_type: 'NORMAL',
      time_in_force: 'DAY', session: 'RTH', remark: `q:${ID}`, trd_env: 'SIMULATE', acc_id: '9001',
    }))
    expect(out.status).toBe('submitted')
    expect(row()?.moomooOrderId).toBe('OID-1')
    expect(row()?.decidedAt).toBeInstanceOf(Date)
    expect(recordPaper).toHaveBeenCalledWith(expect.objectContaining({ source: 'chat', moomooOrderId: 'OID-1', trdEnv: 'SIMULATE' }))
  })

  it('places once when approve is clicked twice', async () => {
    const { store } = memoryStore(proposal())
    const c = client()
    await approveProposal(ID, { store, client: c })
    await expect(approveProposal(ID, { store, client: c })).rejects.toMatchObject({ statusCode: 409 })
    expect(c.placeOrder).toHaveBeenCalledTimes(1)
  })

  it('answers 404 for an unknown proposal', async () => {
    const { store } = memoryStore(null)
    await expect(approveProposal(ID, { store, client: client() })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('marks a proposal past its expiry expired instead of placing it', async () => {
    const { store, row } = memoryStore(proposal({ expiresAt: '2026-11-25T11:00:00Z' }))
    const c = client()
    await expect(approveProposal(ID, { store, client: c })).rejects.toMatchObject({ statusCode: 409 })
    expect(row()?.status).toBe('expired')
    expect(c.placeOrder).not.toHaveBeenCalled()
  })

  it('puts a refused order back in the queue with the reason, so it can be fixed or retried', async () => {
    const { store, row } = memoryStore(proposal({ trdEnv: 'REAL' }))
    const c = client({ placeOrder: vi.fn(async () => { throw httpError(409, 'trade unlock required') }) })
    await expect(approveProposal(ID, { store, client: c })).rejects.toMatchObject({ statusCode: 409 })
    expect(row()?.status).toBe('pending')
    expect(row()?.error).toMatch(/unlock/)
  })

  it('looks the order up by remark when the reply is lost, and marks it submitted if it went through', async () => {
    const { store, row } = memoryStore(proposal())
    const c = client({
      placeOrder: vi.fn(async () => { throw httpError(undefined, 'timeout') }),
      listOrders: vi.fn(async (): Promise<Order[]> => [
        { order_id: 'OTHER', code: 'US.NVDA', side: 'BUY', qty: 3, price: 100, status: 'SUBMITTED', created_at: '', remark: 'q:someone-else' },
        { order_id: 'OID-9', code: 'US.NVDA', side: 'BUY', qty: 3, price: 100, status: 'SUBMITTED', created_at: '', remark: `q:${ID}` },
      ]),
    })
    const out = await approveProposal(ID, { store, client: c })
    expect(out.status).toBe('submitted')
    expect(row()?.moomooOrderId).toBe('OID-9')
    expect(c.listOrders).toHaveBeenCalledWith({ acc_id: '9001', trd_env: 'SIMULATE' })
  })

  it('marks it failed after a lost reply when no order carries its remark', async () => {
    const { store, row } = memoryStore(proposal())
    const c = client({ placeOrder: vi.fn(async () => { throw httpError(502, 'OpenD gone') }) })
    await expect(approveProposal(ID, { store, client: c })).rejects.toMatchObject({ statusCode: 502 })
    expect(row()?.status).toBe('failed')
    expect(row()?.error).toMatch(/Active/)
  })

  it('picks the paper account for the symbol\'s market when the proposal names none', async () => {
    const { store, row } = memoryStore(proposal({ accId: null }))
    const c = client({
      listAccounts: vi.fn(async (): Promise<Account[]> => [
        { acc_id: '1', trd_env: 'REAL', acc_type: 'MARGIN', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'MASTER' },
        { acc_id: '3', trd_env: 'SIMULATE', acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['HK'], acc_role: 'MASTER' },
        { acc_id: '2', trd_env: 'SIMULATE', acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'MASTER' },
      ]),
      placeOrder: vi.fn(async () => placed({ acc_id: '2' })),
    })
    await approveProposal(ID, { store, client: c })
    expect(c.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ acc_id: '2' }))
    expect(row()?.accId).toBe('2')
  })

  it('sends only the fields the order type uses', async () => {
    const { store } = memoryStore(proposal({ trdEnv: 'REAL', orderType: 'TRAILING_STOP', price: 5, trailType: 'RATIO', trailValue: 3, trailSpread: 1 }))
    const c = client()
    await approveProposal(ID, { store, client: c })
    const sent = vi.mocked(c.placeOrder).mock.calls[0]?.[0]
    expect(sent).not.toHaveProperty('price')
    expect(sent).not.toHaveProperty('trail_spread')
    expect(sent).toMatchObject({ trail_type: 'RATIO', trail_value: 3 })
  })
})

describe('createProposal', () => {
  it('refuses an order the api would refuse', async () => {
    const { store } = memoryStore(null)
    await expect(createProposal({
      source: 'ticket', accId: '9001', trdEnv: 'SIMULATE', symbol: 'US.NVDA', side: 'BUY', qty: 1,
      orderType: 'STOP', triggerPrice: 90,
    }, store)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('wants an account for a live proposal', async () => {
    const { store } = memoryStore(null)
    await expect(createProposal({
      source: 'chat', accId: null, trdEnv: 'REAL', symbol: 'US.NVDA', side: 'BUY', qty: 1, price: 1,
    }, store)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('stores a valid one as pending', async () => {
    const { store, row } = memoryStore(null)
    await createProposal({ source: 'chat', accId: null, trdEnv: 'SIMULATE', symbol: 'us.nvda', side: 'BUY', qty: 1, price: 1 }, store)
    expect(row()).toMatchObject({ status: 'pending', symbol: 'US.NVDA' })
  })
})

describe('editProposal', () => {
  it('changes the order fields of a pending proposal', async () => {
    const { store, row } = memoryStore(proposal({ error: 'old refusal' }))
    await editProposal(ID, { qty: 5, price: 99 }, store)
    expect(row()).toMatchObject({ qty: 5, price: 99, error: null })
  })

  it('refuses an edit that breaks a rule', async () => {
    const { store } = memoryStore(proposal())
    await expect(editProposal(ID, { timeInForce: 'GTC' }, store)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('refuses to edit one that has left the queue', async () => {
    const { store } = memoryStore(proposal({ status: 'submitted' }))
    await expect(editProposal(ID, { qty: 2 }, store)).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('placeNow, the ticket Place now button', () => {
  const ticket = { accId: '9001', trdEnv: 'SIMULATE' as const, symbol: 'us.nvda', side: 'BUY' as const, qty: 2, orderType: 'MARKET' as const, price: 50 }

  it('places the order without the fields its type ignores and writes the paper ledger', async () => {
    const c = client()
    const recordPaper = vi.fn(async () => true)
    await placeNow(ticket, c, recordPaper)
    const sent = vi.mocked(c.placeOrder).mock.calls[0]?.[0]
    expect(sent).toMatchObject({ code: 'US.NVDA', order_type: 'MARKET', acc_id: '9001', trd_env: 'SIMULATE' })
    expect(sent).not.toHaveProperty('price')
    expect(recordPaper).toHaveBeenCalledWith(expect.objectContaining({ source: 'ticket', moomooOrderId: 'OID-1' }))
  })

  it('refuses a rule-breaking order before it reaches the api', async () => {
    const c = client()
    await expect(placeNow({ ...ticket, timeInForce: 'GTC' }, c)).rejects.toMatchObject({ statusCode: 422 })
    expect(c.placeOrder).not.toHaveBeenCalled()
  })

  it('passes on the api refusal with its status and reason', async () => {
    const c = client({ placeOrder: vi.fn(async () => { throw httpError(403, 'live trading is off') }) })
    await expect(placeNow({ ...ticket, trdEnv: 'REAL' }, c)).rejects.toMatchObject({ statusCode: 403, statusMessage: 'live trading is off' })
  })
})

describe('resolveSubmitting, unsticking a proposal left in submitting', () => {
  const NOW = new Date('2026-11-25T12:00:00Z')
  const longAgo = new Date(NOW.getTime() - STUCK_AFTER_MS - 1000)
  const stuck = (over: Partial<Proposal> = {}) => proposal({ status: 'submitting', claimedAt: longAgo, ...over })
  const order = (over: Partial<Order> = {}): Order => ({ order_id: 'OID-7', code: 'US.NVDA', side: 'BUY', qty: 3, price: 100, status: 'SUBMITTED', created_at: '', remark: `q:${ID}`, ...over })

  it('marks it submitted when today\'s orders hold one with its remark', async () => {
    const { store, row } = memoryStore(stuck())
    const c = client({ listOrders: vi.fn(async () => [order()]) })
    const out = await resolveSubmitting(ID, { store, client: c, now: NOW })
    expect(out.status).toBe('submitted')
    expect(row()?.moomooOrderId).toBe('OID-7')
  })

  it('also looks in the order history, for one stuck since an earlier day', async () => {
    const { store, row } = memoryStore(stuck())
    const c = client({ listHistoryOrders: vi.fn(async () => [order({ order_id: 'OID-OLD' })]) })
    await resolveSubmitting(ID, { store, client: c, now: NOW })
    expect(row()?.status).toBe('submitted')
    expect(row()?.moomooOrderId).toBe('OID-OLD')
  })

  it('puts it back in the queue with a note when no order carries its remark', async () => {
    const { store, row } = memoryStore(stuck())
    const out = await resolveSubmitting(ID, { store, client: client(), now: NOW })
    expect(out.status).toBe('pending')
    expect(row()?.error).toMatch(/no order/i)
    expect(row()?.claimedAt).toBeNull()
  })

  it('refuses while a placement could still be in flight', async () => {
    const { store, row } = memoryStore(stuck({ claimedAt: new Date(NOW.getTime() - 10_000) }))
    const c = client()
    await expect(resolveSubmitting(ID, { store, client: c, now: NOW })).rejects.toMatchObject({ statusCode: 409 })
    expect(c.listOrders).not.toHaveBeenCalled()
    expect(row()?.status).toBe('submitting')
  })

  it('refuses one that is not submitting', async () => {
    const { store } = memoryStore(proposal())
    await expect(resolveSubmitting(ID, { store, client: client(), now: NOW })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('answers 404 for an unknown proposal', async () => {
    const { store } = memoryStore(null)
    await expect(resolveSubmitting(ID, { store, client: client(), now: NOW })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('leaves it submitting when moomoo cannot be checked, unless forced', async () => {
    const { store, row } = memoryStore(stuck())
    const c = client({ listOrders: vi.fn(async () => { throw httpError(502, 'OpenD gone') }) })
    await expect(resolveSubmitting(ID, { store, client: c, now: NOW })).rejects.toMatchObject({ statusCode: 502 })
    expect(row()?.status).toBe('submitting')
  })

  it('marks it failed, never pending, when forced without a check', async () => {
    const { store, row } = memoryStore(stuck())
    const c = client({ listOrders: vi.fn(async () => { throw httpError(502, 'OpenD gone') }) })
    const out = await resolveSubmitting(ID, { store, client: c, now: NOW, force: true })
    expect(out.status).toBe('failed')
    expect(row()?.error).toMatch(/Active/)
  })

  it('checks the symbol\'s paper account when the proposal names none', async () => {
    const { store } = memoryStore(stuck({ accId: null }))
    const c = client({
      listAccounts: vi.fn(async (): Promise<Account[]> => [
        { acc_id: 'HK1', trd_env: 'SIMULATE', acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['HK'], acc_role: 'MASTER' },
        { acc_id: 'US1', trd_env: 'SIMULATE', acc_type: 'CASH', card_num: null, security_firm: null, trdmarket_auth: ['US'], acc_role: 'MASTER' },
      ]),
    })
    await resolveSubmitting(ID, { store, client: c, now: NOW })
    expect(c.listOrders).toHaveBeenCalledWith({ acc_id: 'US1', trd_env: 'SIMULATE' })
  })
})
