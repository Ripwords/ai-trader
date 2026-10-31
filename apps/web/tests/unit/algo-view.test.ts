import { describe, expect, it } from 'vitest'
import type { AlgoMaturityCheck, AlgoMaturityStatus } from '../../server/lib/algo-risk'
import { SIZING_MODES, backtestOutlivesSave, describeSizing, foldChecks } from '../../app/utils/algo-view'

function check(key: string, status: AlgoMaturityStatus): AlgoMaturityCheck {
  return { key, label: key, status, note: `${key} note` }
}

describe('foldChecks', () => {
  it('collapses an all-passing list into one summary line', () => {
    const fold = foldChecks([check('a', 'pass'), check('b', 'pass'), check('c', 'pass')])
    expect(fold.open).toEqual([])
    expect(fold.passed.map(c => c.key)).toEqual(['a', 'b', 'c'])
    expect(fold.summary).toBe('all 3 checks passed')
  })

  it('opens warn and block checks, blocks first, and counts the passing ones', () => {
    const fold = foldChecks([
      check('a', 'pass'),
      check('b', 'warn'),
      check('c', 'block'),
      check('d', 'pass'),
      check('e', 'warn'),
    ])
    expect(fold.open.map(c => c.key)).toEqual(['c', 'b', 'e'])
    expect(fold.passed.map(c => c.key)).toEqual(['a', 'd'])
    expect(fold.summary).toBe('2 passed')
  })

  it('has no summary when nothing passed', () => {
    const fold = foldChecks([check('a', 'block'), check('b', 'warn')])
    expect(fold.summary).toBeNull()
  })

  it('does not claim success for an empty list', () => {
    expect(foldChecks([]).summary).toBeNull()
  })

  it('uses the singular for one passing check', () => {
    expect(foldChecks([check('a', 'pass')]).summary).toBe('all 1 check passed')
  })
})

describe('describeSizing', () => {
  it('renders each sizing mode in words instead of the enum', () => {
    expect(describeSizing('fixed_qty', 100)).toBe('100 shares per signal')
    expect(describeSizing('pct_equity', 25)).toBe('25% of equity per signal')
    expect(describeSizing('fixed_cash', 5000)).toBe('$5,000 per signal')
  })

  it('uses the singular for one share', () => {
    expect(describeSizing('fixed_qty', 1)).toBe('1 share per signal')
  })

  it('covers every sizing mode with a select label', () => {
    expect(SIZING_MODES.map(m => m.value)).toEqual(['fixed_qty', 'pct_equity', 'fixed_cash'])
    for (const m of SIZING_MODES) expect(m.label).toMatch(/^[a-z$% ]+$/)
  })
})

describe('backtestOutlivesSave', () => {
  const s = { name: 'MA cross', symbol: 'US.AAPL', cadence: '1d', code: 'def on_bar(c): pass', initial_capital: 10000, commission_bps: 5, slippage_bps: 5, sizing_mode: 'fixed_qty', sizing_value: 1, pyramiding_max: 1 }

  it('keeps the backtest through a rename', () => {
    expect(backtestOutlivesSave(s, { ...s, name: 'renamed' })).toBe(true)
  })

  it('drops it when the code changed, so a backtest of the old code does not clear the new code to go live', () => {
    expect(backtestOutlivesSave(s, { ...s, code: 'def on_bar(c): c.buy()' })).toBe(false)
  })

  it('drops it when any setting the backtest used changed', () => {
    expect(backtestOutlivesSave(s, { ...s, slippage_bps: 20 })).toBe(false)
    expect(backtestOutlivesSave(s, { ...s, symbol: 'US.MSFT' })).toBe(false)
  })
})
