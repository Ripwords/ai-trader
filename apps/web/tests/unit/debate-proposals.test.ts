import { describe, expect, it, vi } from 'vitest'
import { proposeFromDecision, type DebateProposalDeps } from '../../server/lib/debate-proposals'
import { DEFAULT_TRADING_SETTINGS, tradingSettingsSchema, type TradingSettings } from '../../types/trading'
import type { ProposalInput } from '../../server/lib/order-proposals'

const ON: TradingSettings = { debateProposals: true, accId: null, trdEnv: 'SIMULATE', notional: 1000 }

function deps(over: Partial<DebateProposalDeps> = {}, settings: TradingSettings = ON) {
  const created: ProposalInput[] = []
  const d: DebateProposalDeps = {
    getSettings: async () => settings,
    getLastPrice: vi.fn(async () => 300),
    getHeldQty: vi.fn(async () => 7),
    create: async (input) => { created.push(input) },
    ...over,
  }
  return { d, created }
}

const decision = (rating: string) => ({ decisionId: 'd-1', symbol: 'US.AAPL', rating, confidence: 64, rationale: 'Strong services growth.' })

describe('proposeFromDecision', () => {
  it('does nothing while the setting is off', async () => {
    const { d, created } = deps({}, DEFAULT_TRADING_SETTINGS)
    expect(await proposeFromDecision(decision('buy'), d)).toEqual({ created: false, reason: 'off' })
    expect(created).toEqual([])
  })

  it('turns a buy into a limit order at the last price, sized to the notional', async () => {
    const { d, created } = deps()
    expect(await proposeFromDecision(decision('buy'), d)).toEqual({ created: true })
    expect(created[0]).toMatchObject({
      source: 'debate', decisionId: 'd-1', accId: null, trdEnv: 'SIMULATE', symbol: 'US.AAPL', side: 'BUY',
      qty: 3, orderType: 'NORMAL', price: 300, timeInForce: 'DAY', session: 'RTH',
    })
    expect(created[0]!.rationale).toMatch(/BUY.*64%.*Strong services/s)
  })

  it('treats strong-buy as a buy', async () => {
    const { d, created } = deps()
    await proposeFromDecision(decision('strong-buy'), d)
    expect(created[0]).toMatchObject({ side: 'BUY' })
  })

  it('creates nothing for a hold', async () => {
    const { d, created } = deps()
    expect(await proposeFromDecision(decision('hold'), d)).toEqual({ created: false, reason: 'not a buy or sell' })
    expect(created).toEqual([])
  })

  it('sells the whole position on a sell, and half on a reduce', async () => {
    const sell = deps()
    await proposeFromDecision(decision('sell'), sell.d)
    expect(sell.created[0]).toMatchObject({ side: 'SELL', qty: 7, price: 300 })
    const reduce = deps()
    await proposeFromDecision(decision('reduce'), reduce.d)
    expect(reduce.created[0]).toMatchObject({ side: 'SELL', qty: 3 })
  })

  it('creates nothing for a sell with no position', async () => {
    const { d, created } = deps({ getHeldQty: async () => 0 })
    expect(await proposeFromDecision(decision('sell'), d)).toEqual({ created: false, reason: 'no position to sell' })
    expect(created).toEqual([])
  })

  it('creates nothing when the notional buys less than one share', async () => {
    const { d, created } = deps({ getLastPrice: async () => 5000 })
    expect(await proposeFromDecision(decision('buy'), d)).toEqual({ created: false, reason: 'notional below one share' })
    expect(created).toEqual([])
  })

  it('creates nothing without a price or a market prefix', async () => {
    expect(await proposeFromDecision(decision('buy'), deps({ getLastPrice: async () => null }).d)).toEqual({ created: false, reason: 'no price' })
    expect(await proposeFromDecision({ ...decision('buy'), symbol: 'AAPL' }, deps().d)).toEqual({ created: false, reason: 'no market prefix' })
  })

  it('targets the account the setting names', async () => {
    const { d, created } = deps({}, { ...ON, accId: '555', trdEnv: 'REAL' })
    await proposeFromDecision(decision('buy'), d)
    expect(created[0]).toMatchObject({ accId: '555', trdEnv: 'REAL' })
    expect(d.getHeldQty).not.toHaveBeenCalled()
  })
})

describe('trading settings', () => {
  it('needs an account for a live target', () => {
    expect(tradingSettingsSchema.safeParse({ ...ON, trdEnv: 'REAL', accId: null }).success).toBe(false)
    expect(tradingSettingsSchema.safeParse({ ...ON, trdEnv: 'REAL', accId: '1' }).success).toBe(true)
  })
  it('starts off, on paper, at 1000 a proposal', () => {
    expect(DEFAULT_TRADING_SETTINGS).toEqual({ debateProposals: false, accId: null, trdEnv: 'SIMULATE', notional: 1000 })
  })
})
