import { describe, expect, it } from 'vitest'
import {
  allowedOrderTypes,
  allowedSessions,
  allowedTimeInForce,
  orderFieldsFor,
  orderRuleProblem,
  pickOrderFields,
} from '../../server/lib/order-types'

// A client-side copy of apps/api/app/services/order_rules.py, for hiding
// fields and catching a bad combination before it is queued. The api still
// decides; these cases are the ones tests/test_order_rules.py pins there.

describe('which fields an order type uses', () => {
  it('asks a limit order for a price only', () => {
    expect(orderFieldsFor('NORMAL')).toEqual({ price: true, trigger: false, trail: false, spread: false })
  })
  it('asks a market order for nothing', () => {
    expect(orderFieldsFor('MARKET')).toEqual({ price: false, trigger: false, trail: false, spread: false })
  })
  it('asks a stop limit for a trigger and a limit', () => {
    expect(orderFieldsFor('STOP_LIMIT')).toEqual({ price: true, trigger: true, trail: false, spread: false })
  })
  it('asks a trailing stop limit for a trail and a spread', () => {
    expect(orderFieldsFor('TRAILING_STOP_LIMIT')).toEqual({ price: false, trigger: false, trail: true, spread: true })
  })
})

describe('the choices an account offers', () => {
  it('gives a paper account NORMAL and MARKET, DAY only', () => {
    expect(allowedOrderTypes('SIMULATE')).toEqual(['NORMAL', 'MARKET'])
    expect(allowedTimeInForce('SIMULATE')).toEqual(['DAY'])
  })
  it('gives a live account every type and GTC', () => {
    expect(allowedOrderTypes('REAL')).toHaveLength(8)
    expect(allowedTimeInForce('REAL')).toEqual(['DAY', 'GTC'])
  })
  it('offers no session choice outside US stocks', () => {
    expect(allowedSessions({ trdEnv: 'REAL', orderType: 'NORMAL', code: 'HK.00700' })).toEqual(['RTH'])
  })
  it('keeps a market order in regular hours', () => {
    expect(allowedSessions({ trdEnv: 'REAL', orderType: 'MARKET', code: 'US.NVDA' })).toEqual(['RTH'])
  })
  it('offers overnight to a live limit order only', () => {
    expect(allowedSessions({ trdEnv: 'REAL', orderType: 'NORMAL', code: 'US.NVDA' })).toEqual(['RTH', 'ETH', 'OVERNIGHT', 'ALL'])
    expect(allowedSessions({ trdEnv: 'REAL', orderType: 'STOP', code: 'US.NVDA' })).toEqual(['RTH', 'ETH'])
    expect(allowedSessions({ trdEnv: 'SIMULATE', orderType: 'NORMAL', code: 'US.NVDA' })).toEqual(['RTH', 'ETH'])
  })
})

describe('orderRuleProblem', () => {
  const base = { code: 'US.NVDA', side: 'BUY' as const, qty: 1, trd_env: 'REAL' as const }

  it('passes a plain limit order', () => {
    expect(orderRuleProblem({ ...base, order_type: 'NORMAL', price: 100 })).toBeNull()
  })
  it('wants a limit price', () => {
    expect(orderRuleProblem({ ...base, order_type: 'NORMAL' })).toMatch(/price/)
  })
  it('wants a trigger for a stop', () => {
    expect(orderRuleProblem({ ...base, order_type: 'STOP' })).toMatch(/trigger/)
  })
  it('wants a trail for a trailing stop', () => {
    expect(orderRuleProblem({ ...base, order_type: 'TRAILING_STOP', trail_type: 'RATIO' })).toMatch(/trail/)
  })
  it('refuses a paper stop, a paper GTC and a paper overnight order', () => {
    const paper = { ...base, trd_env: 'SIMULATE' as const }
    expect(orderRuleProblem({ ...paper, order_type: 'STOP', trigger_price: 90 })).toMatch(/paper/)
    expect(orderRuleProblem({ ...paper, order_type: 'NORMAL', price: 1, time_in_force: 'GTC' })).toMatch(/DAY/)
    expect(orderRuleProblem({ ...paper, order_type: 'NORMAL', price: 1, session: 'OVERNIGHT' })).toMatch(/overnight/)
  })
  it('refuses a market order outside regular hours and an overnight stop', () => {
    expect(orderRuleProblem({ ...base, order_type: 'MARKET', session: 'ETH' })).toMatch(/regular hours/)
    expect(orderRuleProblem({ ...base, order_type: 'STOP', trigger_price: 1, session: 'ALL' })).toMatch(/limit/)
  })
  it('refuses a session on a non-US code', () => {
    expect(orderRuleProblem({ ...base, code: 'HK.00700', order_type: 'NORMAL', price: 1, session: 'ETH' })).toMatch(/US/)
  })
  it('wants a whole positive quantity', () => {
    expect(orderRuleProblem({ ...base, qty: 0, order_type: 'MARKET' })).toMatch(/quantity/)
  })
})

describe('pickOrderFields', () => {
  it('drops the fields the type does not use, so the api never sees a stray spread', () => {
    expect(pickOrderFields({
      code: 'US.NVDA', side: 'SELL', qty: 2, order_type: 'TRAILING_STOP',
      price: 10, trigger_price: 9, trail_type: 'RATIO', trail_value: 5, trail_spread: 0.1,
      time_in_force: 'GTC', session: 'RTH',
    })).toEqual({
      code: 'US.NVDA', side: 'SELL', qty: 2, order_type: 'TRAILING_STOP',
      trail_type: 'RATIO', trail_value: 5, time_in_force: 'GTC', session: 'RTH',
    })
  })
})
