import { describe, expect, it } from 'vitest'
import {
  containsPhrase,
  expectedLiveModifyConfirmation,
  expectedLivePlaceConfirmation,
} from '../../server/llm/tools'
import {
  ORDER_TYPES,
  orderTypeSchema,
  sessionSchema,
  timeInForceSchema,
  trailTypeSchema,
} from '../../server/lib/order-types'

describe('live confirmation phrases for stop orders', () => {
  it('keeps the existing NORMAL phrase shape', () => {
    expect(
      expectedLivePlaceConfirmation({ code: 'US.NVDA', side: 'BUY', qty: 10, price: 100 }),
    ).toBe('LIVE PLACE BUY 10 US.NVDA NORMAL @ 100')
  })

  it('includes the STOP order type and trigger price', () => {
    expect(
      expectedLivePlaceConfirmation({
        code: 'US.NVDA',
        side: 'SELL',
        qty: 10,
        order_type: 'STOP',
        trigger_price: 95,
      }),
    ).toBe('LIVE PLACE SELL 10 US.NVDA STOP TRIG 95')
  })

  it('includes both limit and trigger for STOP_LIMIT', () => {
    expect(
      expectedLivePlaceConfirmation({
        code: 'US.NVDA',
        side: 'SELL',
        qty: 10,
        price: 94.5,
        order_type: 'STOP_LIMIT',
        trigger_price: 95,
      }),
    ).toBe('LIVE PLACE SELL 10 US.NVDA STOP_LIMIT @ 94.5 TRIG 95')
  })

  it('includes the trigger price in modify confirmations', () => {
    expect(
      expectedLiveModifyConfirmation({ order_id: 'ord-1', trigger_price: 96 }),
    ).toBe('LIVE MODIFY ORD-1 TRIG 96')
    expect(
      expectedLiveModifyConfirmation({ order_id: 'ord-1', price: 99, qty: 5 }),
    ).toBe('LIVE MODIFY ORD-1 PRICE 99 QTY 5')
  })
})

describe('order settings shared by the api client and the chat tools', () => {
  it('lists the moomoo order types the api accepts', () => {
    expect(ORDER_TYPES).toEqual([
      'NORMAL', 'MARKET', 'STOP', 'STOP_LIMIT',
      'MARKET_IF_TOUCHED', 'LIMIT_IF_TOUCHED', 'TRAILING_STOP', 'TRAILING_STOP_LIMIT',
    ])
    expect(orderTypeSchema.safeParse('TRAILING_STOP_LIMIT').success).toBe(true)
    expect(orderTypeSchema.safeParse('TWAP').success).toBe(false)
  })

  it('takes DAY and GTC, the four US sessions and both trail types', () => {
    expect(timeInForceSchema.options).toEqual(['DAY', 'GTC'])
    expect(sessionSchema.options).toEqual(['RTH', 'ETH', 'OVERNIGHT', 'ALL'])
    expect(trailTypeSchema.options).toEqual(['RATIO', 'AMOUNT'])
  })
})

describe('live confirmation phrases for the newer order settings', () => {
  it('leaves DAY and RTH out, so an old-style order keeps its old phrase', () => {
    expect(
      expectedLivePlaceConfirmation({
        code: 'US.NVDA', side: 'BUY', qty: 10, price: 100, time_in_force: 'DAY', session: 'RTH',
      }),
    ).toBe('LIVE PLACE BUY 10 US.NVDA NORMAL @ 100')
  })

  it('names a GTC order and a non-regular session', () => {
    expect(
      expectedLivePlaceConfirmation({
        code: 'US.NVDA', side: 'BUY', qty: 10, price: 100, time_in_force: 'GTC', session: 'OVERNIGHT',
      }),
    ).toBe('LIVE PLACE BUY 10 US.NVDA NORMAL @ 100 TIF GTC SESSION OVERNIGHT')
  })

  it('names the trail and spread of a trailing stop limit', () => {
    expect(
      expectedLivePlaceConfirmation({
        code: 'US.NVDA', side: 'SELL', qty: 10, order_type: 'TRAILING_STOP_LIMIT',
        trail_type: 'RATIO', trail_value: 5, trail_spread: 0.1,
      }),
    ).toBe('LIVE PLACE SELL 10 US.NVDA TRAILING_STOP_LIMIT TRAIL RATIO 5 SPREAD 0.1')
  })

  it('names the trigger of an if-touched order', () => {
    expect(
      expectedLivePlaceConfirmation({
        code: 'US.NVDA', side: 'BUY', qty: 10, order_type: 'LIMIT_IF_TOUCHED', price: 90, trigger_price: 91,
      }),
    ).toBe('LIVE PLACE BUY 10 US.NVDA LIMIT_IF_TOUCHED @ 90 TRIG 91')
  })

  it('names a new trail in a modify', () => {
    expect(
      expectedLiveModifyConfirmation({ order_id: 'ord-1', trail_type: 'AMOUNT', trail_value: 2.5, trail_spread: 0.05 }),
    ).toBe('LIVE MODIFY ORD-1 TRAIL AMOUNT 2.5 SPREAD 0.05')
  })

  it('does not let a confirmed GTC or session be dropped from the order sent', () => {
    const typed = 'LIVE PLACE BUY 10 US.NVDA NORMAL @ 100 TIF GTC SESSION ETH'
    expect(containsPhrase(typed, 'LIVE PLACE BUY 10 US.NVDA NORMAL @ 100')).toBe(false)
    expect(containsPhrase(typed, 'LIVE PLACE BUY 10 US.NVDA NORMAL @ 100 TIF GTC')).toBe(false)
    expect(containsPhrase(typed, typed)).toBe(true)
    expect(
      containsPhrase('LIVE MODIFY ORD-1 TRAIL RATIO 5 SPREAD 1', 'LIVE MODIFY ORD-1 TRAIL RATIO 5'),
    ).toBe(false)
  })
})
