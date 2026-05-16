export type AlgoMaturityStatus = 'pass' | 'warn' | 'block'

export interface AlgoMaturityCheck {
  key: string
  label: string
  status: AlgoMaturityStatus
  note: string
}

export interface AlgoMaturityAssessment {
  status: AlgoMaturityStatus
  score: number
  checks: AlgoMaturityCheck[]
}

interface StrategyRiskInput {
  initial_capital: number
  sizing_mode: 'fixed_qty' | 'pct_equity' | 'fixed_cash'
  sizing_value: number
}

interface BacktestRiskInput {
  status: string
  metrics: {
    pnl: number
    benchmark_pnl: number
    max_dd: number
    sharpe: number
    round_trips: number
    fills: number
    win_rate: number
    wins: number
    losses: number
  } | null
}

interface SignalRiskInput {
  error?: string | null
}

function worstStatus(checks: AlgoMaturityCheck[]): AlgoMaturityStatus {
  if (checks.some(check => check.status === 'block')) return 'block'
  if (checks.some(check => check.status === 'warn')) return 'warn'
  return 'pass'
}

function scoreFor(checks: AlgoMaturityCheck[]): number {
  const raw = checks.reduce((score, check) => {
    if (check.status === 'block') return score - 28
    if (check.status === 'warn') return score - 12
    return score
  }, 100)
  return Math.max(0, Math.min(100, raw))
}

export function assessAlgoMaturity(
  strategy: StrategyRiskInput,
  backtest: BacktestRiskInput | null,
  signals: SignalRiskInput[] = [],
): AlgoMaturityAssessment {
  const checks: AlgoMaturityCheck[] = []

  if (!backtest || backtest.status !== 'ok' || !backtest.metrics) {
    checks.push({
      key: 'backtest',
      label: 'Backtest',
      status: 'block',
      note: 'Run a successful backtest before enabling live paper ticks.',
    })
  } else {
    const m = backtest.metrics
    checks.push({
      key: 'backtest',
      label: 'Backtest',
      status: 'pass',
      note: 'Latest backtest completed.',
    })
    checks.push({
      key: 'trades',
      label: 'Closed Trades',
      status: m.round_trips <= 0 ? 'block' : m.round_trips < 3 ? 'warn' : 'pass',
      note: m.round_trips <= 0
        ? 'No closed trades; performance is not meaningful yet.'
        : `${m.round_trips} closed trade${m.round_trips === 1 ? '' : 's'} in sample.`,
    })
    checks.push({
      key: 'drawdown',
      label: 'Drawdown',
      status: m.max_dd > 0.35 ? 'block' : m.max_dd > 0.25 ? 'warn' : 'pass',
      note: `Max drawdown ${(m.max_dd * 100).toFixed(1)}%.`,
    })
    checks.push({
      key: 'edge',
      label: 'Edge',
      status: m.pnl < 0 ? 'block' : m.pnl < m.benchmark_pnl ? 'warn' : 'pass',
      note: m.pnl < m.benchmark_pnl
        ? `PnL ${m.pnl.toFixed(2)} trails benchmark ${m.benchmark_pnl.toFixed(2)}.`
        : `PnL ${m.pnl.toFixed(2)} beats benchmark ${m.benchmark_pnl.toFixed(2)}.`,
    })
    checks.push({
      key: 'sharpe',
      label: 'Sharpe',
      status: m.sharpe < 0 ? 'warn' : m.sharpe < 0.5 ? 'warn' : 'pass',
      note: `Backtest Sharpe ${m.sharpe.toFixed(2)}.`,
    })
  }

  const sizingStatus: AlgoMaturityStatus = (() => {
    if (strategy.sizing_mode === 'pct_equity') {
      if (strategy.sizing_value > 100) return 'block'
      if (strategy.sizing_value > 50) return 'warn'
    }
    if (strategy.sizing_mode === 'fixed_cash') {
      const pct = strategy.initial_capital > 0 ? strategy.sizing_value / strategy.initial_capital : 1
      if (pct > 1) return 'block'
      if (pct > 0.5) return 'warn'
    }
    return 'pass'
  })()
  checks.push({
    key: 'sizing',
    label: 'Sizing',
    status: sizingStatus,
    note: strategy.sizing_mode === 'pct_equity'
      ? `${strategy.sizing_value}% of equity per signal.`
      : strategy.sizing_mode === 'fixed_cash'
        ? `$${strategy.sizing_value.toFixed(2)} per signal on $${strategy.initial_capital.toFixed(2)} capital.`
        : `${strategy.sizing_value} share${strategy.sizing_value === 1 ? '' : 's'} per signal.`,
  })

  if (signals.length > 0) {
    const errorCount = signals.filter(signal => signal.error).length
    const errorRate = errorCount / signals.length
    checks.push({
      key: 'signals',
      label: 'Live Signal Health',
      status: errorRate > 0.5 ? 'block' : errorRate > 0 ? 'warn' : 'pass',
      note: `${errorCount}/${signals.length} recent signal${signals.length === 1 ? '' : 's'} had order errors.`,
    })
  }

  return {
    status: worstStatus(checks),
    score: scoreFor(checks),
    checks,
  }
}
