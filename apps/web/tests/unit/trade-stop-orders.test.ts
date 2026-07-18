import { describe, expect, it } from 'vitest'
import {
  expectedLiveModifyConfirmation,
  expectedLivePlaceConfirmation,
} from '../../server/llm/tools'

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
