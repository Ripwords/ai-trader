import { describe, expect, it } from 'vitest'
import {
  describeOrder,
  fillLabel,
  orderBody,
  proposalSettings,
  orderTypeLabel,
  parseOrdersTab,
  priceSummary,
  proposalIdFromRemark,
  sessionLabel,
} from '../../app/utils/orders-view'

describe('parseOrdersTab', () => {
  it('reads approvals and falls back to active', () => {
    expect(parseOrdersTab('approvals')).toBe('approvals')
    expect(parseOrdersTab('nope')).toBe('active')
    expect(parseOrdersTab(undefined)).toBe('active')
  })
})

describe('labels', () => {
  it('names order types in words', () => {
    expect(orderTypeLabel('NORMAL')).toBe('limit')
    expect(orderTypeLabel('TRAILING_STOP_LIMIT')).toBe('trailing stop limit')
    expect(orderTypeLabel('ODD_LOT')).toBe('ODD_LOT')
    expect(orderTypeLabel(null)).toBe('—')
  })
  it('names sessions in words', () => {
    expect(sessionLabel('RTH')).toBe('regular hours')
    expect(sessionLabel('ETH')).toBe('extended hours')
    expect(sessionLabel(null)).toBe('—')
  })
  it('shows filled over total', () => {
    expect(fillLabel(0, 10)).toBe('0/10')
    expect(fillLabel(null, 10)).toBe('0/10')
    expect(fillLabel(2.5, 10)).toBe('2.5/10')
  })
})

describe('priceSummary', () => {
  it('shows the limit for a limit order', () => {
    expect(priceSummary({ order_type: 'NORMAL', price: 120 })).toBe('lmt 120.00')
  })
  it('shows market for a market order', () => {
    expect(priceSummary({ order_type: 'MARKET', price: 0 })).toBe('market')
  })
  it('shows trigger and limit for a stop limit', () => {
    expect(priceSummary({ order_type: 'STOP_LIMIT', price: 99, trigger_price: 100 })).toBe('trig 100.00 · lmt 99.00')
  })
  it('shows a ratio trail as a percent and the spread', () => {
    expect(priceSummary({ order_type: 'TRAILING_STOP_LIMIT', trail_type: 'RATIO', trail_value: 5, trail_spread: 0.1 }))
      .toBe('trail 5% · spread 0.10')
  })
  it('shows an amount trail as a price distance', () => {
    expect(priceSummary({ order_type: 'TRAILING_STOP', trail_type: 'AMOUNT', trail_value: 2 })).toBe('trail 2.00')
  })
})

describe('describeOrder', () => {
  it('spells out a live order', () => {
    expect(describeOrder({
      code: 'US.NVDA', side: 'BUY', qty: 10, order_type: 'NORMAL', price: 120,
      time_in_force: 'GTC', session: 'RTH',
    }, { trdEnv: 'REAL', accountLabel: 'Live US ··0123' }))
      .toBe('BUY 10 US.NVDA, limit at 120.00, good till cancelled, regular hours, on Live US ··0123. This is a LIVE order with real money.')
  })
  it('describes a paper market order without the live warning', () => {
    expect(describeOrder({ code: 'US.NVDA', side: 'SELL', qty: 1, order_type: 'MARKET' }, { trdEnv: 'SIMULATE', accountLabel: 'Paper US' }))
      .toBe('SELL 1 US.NVDA, market, day only, regular hours, on Paper US.')
  })
})

describe('proposalIdFromRemark', () => {
  it('reads the queue id out of a q: remark', () => {
    expect(proposalIdFromRemark('q:7b0c3f2e-1d2a-4c5b-9e8f-0a1b2c3d4e5f')).toBe('7b0c3f2e-1d2a-4c5b-9e8f-0a1b2c3d4e5f')
    expect(proposalIdFromRemark('manual note')).toBeNull()
    expect(proposalIdFromRemark(null)).toBeNull()
  })
})

describe('proposal and body mapping', () => {
  it('builds order settings from a queued proposal, dropping unused fields', () => {
    expect(proposalSettings({
      symbol: 'US.NVDA', side: 'BUY', qty: 3, orderType: 'MARKET', price: 120, triggerPrice: null,
      trailType: null, trailValue: null, trailSpread: null, timeInForce: 'DAY', session: 'RTH',
    })).toEqual({ code: 'US.NVDA', side: 'BUY', qty: 3, order_type: 'MARKET', time_in_force: 'DAY', session: 'RTH' })
  })
  it('sends nulls for the fields a type does not use, so an edit clears them', () => {
    expect(orderBody({ code: 'US.NVDA', side: 'BUY', qty: 2, order_type: 'MARKET', price: 120, time_in_force: 'DAY', session: 'RTH' }))
      .toEqual({ qty: 2, orderType: 'MARKET', price: null, triggerPrice: null, trailType: null, trailValue: null, trailSpread: null, timeInForce: 'DAY', session: 'RTH' })
  })
})
