import { describe, expect, it, vi } from 'vitest'
import { alertQuote, checkNewAlert, newAlertProblem } from '../../server/lib/alert-quote'
import type { Snapshot } from '../../server/llm/http'

const snap = (lastPrice: number, prevClosePrice = 100): Snapshot => ({
  code: 'US.NVDA', name: 'NVIDIA', lastPrice, openPrice: 0, highPrice: 0, lowPrice: 0,
  prevClosePrice, changeRate: 0, volume: 0, turnover: 0, updateTime: '2026-10-30 16:00:00',
})

describe('alertQuote', () => {
  it('uses the moomoo snapshot when OpenD has the symbol', async () => {
    const yahoo = vi.fn()
    const q = await alertQuote('US.NVDA', { snapshot: async () => snap(180), yahoo })
    expect(q.lastPrice).toBe(180)
    expect(yahoo).not.toHaveBeenCalled()
  })

  it("falls back to Yahoo for symbols OpenD refuses, so an SGX or crypto alert can fire", async () => {
    const q = await alertQuote('D05.SI', {
      snapshot: async () => { throw new Error('unknown stock D05.SI') },
      yahoo: async () => ({ name: 'DBS', lastPrice: 41.2, openPrice: null, highPrice: 41.5, lowPrice: 40.9, prevClosePrice: 40.8, changeRate: 0.0098, volume: null, updateTime: null }),
    })
    expect(q.lastPrice).toBe(41.2)
    expect(q.prevClosePrice).toBe(40.8)
    // Missing fields read as 0, which the evaluator and the email treat as absent.
    expect(q.openPrice).toBe(0)
    expect(q.volume).toBe(0)
  })

  it('throws the moomoo error when Yahoo has no price either', async () => {
    await expect(alertQuote('XX.NOPE', {
      snapshot: async () => { throw new Error('unknown stock') },
      yahoo: async () => null,
    })).rejects.toThrow('unknown stock')
  })
})

describe('newAlertProblem', () => {
  it('rejects an above-alert the price already satisfies: "hits 150" with NVDA at 180 means below', () => {
    expect(newAlertProblem('US.NVDA', { kind: 'price_above', threshold: 150 }, snap(180)))
      .toMatch(/already at 180\.00.*price_below/)
  })

  it('rejects a below-alert the price already satisfies', () => {
    expect(newAlertProblem('US.TSLA', { kind: 'price_below', threshold: 250 }, snap(200)))
      .toMatch(/already at 200\.00.*price_above/)
  })

  it("rejects a day-move alert the session's move already exceeds", () => {
    expect(newAlertProblem('US.AAPL', { kind: 'pct_move_day', threshold: 3 }, snap(103.4, 100)))
      .toMatch(/already moved \+3\.4%/)
  })

  it('accepts an alert the price has not reached', () => {
    expect(newAlertProblem('US.NVDA', { kind: 'price_above', threshold: 200 }, snap(180))).toBeNull()
    expect(newAlertProblem('US.AAPL', { kind: 'pct_move_day', threshold: 5 }, snap(103, 100))).toBeNull()
  })

  it('rejects a percent threshold of 100 or more, which a day move cannot reach downward and is usually a price typed by mistake', () => {
    expect(newAlertProblem('US.NVDA', { kind: 'pct_move_day', threshold: 150 }, snap(180)))
      .toMatch(/percent/)
  })
})

describe('checkNewAlert', () => {
  it('refuses a symbol neither source can price, since its alert could never fire', async () => {
    const problem = await checkNewAlert('XX.NOPE', { kind: 'price_above', threshold: 10 }, {
      snapshot: async () => { throw new Error('unknown stock') },
      yahoo: async () => null,
    })
    expect(problem).toMatch(/no price is available for XX\.NOPE/)
  })
})
