import { describe, expect, it } from 'vitest'
import { assessAlgoMaturity } from '../../server/lib/algo-risk'

const strategy = {
  initial_capital: 100_000,
  sizing_mode: 'pct_equity' as const,
  sizing_value: 25,
}

describe('algo maturity assessment', () => {
  it('blocks live enablement when no successful backtest exists', () => {
    const out = assessAlgoMaturity(strategy, null, [])
    expect(out.status).toBe('block')
    expect(out.checks).toContainEqual(expect.objectContaining({ key: 'backtest', status: 'block' }))
  })

  it('blocks strategies with severe drawdown or no closed trades', () => {
    const out = assessAlgoMaturity(strategy, {
      status: 'ok',
      metrics: {
        pnl: 500,
        benchmark_pnl: 1000,
        max_dd: 0.42,
        sharpe: 0.1,
        round_trips: 0,
        fills: 3,
        win_rate: 0,
        wins: 0,
        losses: 0,
      },
    }, [])

    expect(out.status).toBe('block')
    expect(out.checks.map(check => [check.key, check.status])).toContainEqual(['drawdown', 'block'])
    expect(out.checks.map(check => [check.key, check.status])).toContainEqual(['trades', 'block'])
  })

  it('warns but allows a profitable strategy with moderate live signal errors', () => {
    const out = assessAlgoMaturity(strategy, {
      status: 'ok',
      metrics: {
        pnl: 2500,
        benchmark_pnl: 1200,
        max_dd: 0.18,
        sharpe: 0.8,
        round_trips: 6,
        fills: 12,
        win_rate: 0.58,
        wins: 4,
        losses: 2,
      },
    }, [
      { error: null },
      { error: 'order rejected' },
      { error: null },
      { error: null },
    ])

    expect(out.status).toBe('warn')
    expect(out.score).toBeGreaterThan(50)
    expect(out.checks.map(check => [check.key, check.status])).toContainEqual(['signals', 'warn'])
  })
})
