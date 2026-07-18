import { describe, expect, it } from 'vitest'
import { evaluateAlert } from '../../server/lib/alerts-core'

const quote = (lastPrice: number, prevClosePrice = 100) => ({ lastPrice, prevClosePrice })

describe('evaluateAlert', () => {
  describe('price_above', () => {
    it('triggers when last price crosses above the threshold', () => {
      expect(evaluateAlert({ kind: 'price_above', threshold: 150 }, quote(151)))
        .toEqual({ triggered: true, price: 151 })
    })

    it('triggers on exact touch (last === threshold)', () => {
      expect(evaluateAlert({ kind: 'price_above', threshold: 150 }, quote(150)))
        .toEqual({ triggered: true, price: 150 })
    })

    it('does not trigger below the threshold', () => {
      expect(evaluateAlert({ kind: 'price_above', threshold: 150 }, quote(149.99))).toBeNull()
    })
  })

  describe('price_below', () => {
    it('triggers when last price crosses below the threshold', () => {
      expect(evaluateAlert({ kind: 'price_below', threshold: 90 }, quote(89.5)))
        .toEqual({ triggered: true, price: 89.5 })
    })

    it('triggers on exact touch (last === threshold)', () => {
      expect(evaluateAlert({ kind: 'price_below', threshold: 90 }, quote(90)))
        .toEqual({ triggered: true, price: 90 })
    })

    it('does not trigger above the threshold', () => {
      expect(evaluateAlert({ kind: 'price_below', threshold: 90 }, quote(90.01))).toBeNull()
    })
  })

  describe('pct_move_day', () => {
    it('triggers on an up-move >= threshold pct vs prev close', () => {
      // 105 vs 100 = +5%
      expect(evaluateAlert({ kind: 'pct_move_day', threshold: 5 }, quote(105, 100)))
        .toEqual({ triggered: true, price: 105 })
    })

    it('triggers on a down-move (abs) >= threshold pct', () => {
      // 94 vs 100 = -6%
      expect(evaluateAlert({ kind: 'pct_move_day', threshold: 5 }, quote(94, 100)))
        .toEqual({ triggered: true, price: 94 })
    })

    it('does not trigger when the move is smaller than the threshold', () => {
      // 104 vs 100 = +4%
      expect(evaluateAlert({ kind: 'pct_move_day', threshold: 5 }, quote(104, 100))).toBeNull()
    })

    it('skips (null) when prev close is missing or zero — no divide-by-zero false trigger', () => {
      expect(evaluateAlert({ kind: 'pct_move_day', threshold: 5 }, quote(105, 0))).toBeNull()
      expect(evaluateAlert({ kind: 'pct_move_day', threshold: 5 }, quote(105, Number.NaN))).toBeNull()
    })
  })

  describe('unavailable market data', () => {
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'skips evaluation when last price is %p',
      (last) => {
        expect(evaluateAlert({ kind: 'price_above', threshold: 1 }, quote(last))).toBeNull()
        expect(evaluateAlert({ kind: 'price_below', threshold: 1e9 }, quote(last))).toBeNull()
        expect(evaluateAlert({ kind: 'pct_move_day', threshold: 0.0001 }, quote(last))).toBeNull()
      },
    )

    it('skips when the threshold itself is not finite', () => {
      expect(evaluateAlert({ kind: 'price_above', threshold: Number.NaN }, quote(100))).toBeNull()
    })
  })
})
