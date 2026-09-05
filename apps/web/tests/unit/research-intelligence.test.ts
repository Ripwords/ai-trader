import { describe, expect, it } from 'vitest'
import { buildResearchIntelligence } from '../../server/lib/research-intelligence'

describe('research intelligence', () => {
  it('prioritizes running, uncompleted, stale, and weak-reflection symbols', () => {
    const out = buildResearchIntelligence([
      {
        id: 'run-running',
        symbol: 'MSFT',
        status: 'running',
        startedAt: '2026-05-16T00:00:00.000Z',
        finishedAt: null,
        rating: null,
        confidence: null,
        alpha: null,
        outcome: null,
        costUsd: null,
      },
      {
        id: 'run-failed',
        symbol: 'TSLA',
        status: 'failed',
        startedAt: '2026-05-15T00:00:00.000Z',
        finishedAt: '2026-05-15T00:10:00.000Z',
        rating: null,
        confidence: null,
        alpha: null,
        outcome: null,
        costUsd: 0.2,
      },
      {
        id: 'run-stale',
        symbol: 'NVDA',
        status: 'complete',
        startedAt: '2026-04-20T00:00:00.000Z',
        finishedAt: '2026-04-20T00:10:00.000Z',
        rating: 'buy',
        confidence: 72,
        alpha: 3,
        outcome: 'correct',
        costUsd: 0.5,
      },
      {
        id: 'run-weak',
        symbol: 'AAPL',
        status: 'complete',
        startedAt: '2026-05-12T00:00:00.000Z',
        finishedAt: '2026-05-12T00:10:00.000Z',
        rating: 'hold',
        confidence: 60,
        alpha: -8,
        outcome: 'wrong',
        costUsd: 0.3,
      },
    ], new Date('2026-05-16T12:00:00.000Z'))

    expect(out.summary).toEqual({
      total_symbols: 4,
      running_symbols: 1,
      stale_symbols: 1,
      failed_runs_7d: 1,
      avg_confidence: 66,
      total_cost_30d: 1,
    })
    expect(out.queue.map(item => [item.symbol, item.action, item.severity])).toEqual([
      ['MSFT', 'monitor_running', 'high'],
      ['TSLA', 'rerun_failed', 'high'],
      ['AAPL', 'review_thesis', 'medium'],
      ['NVDA', 'refresh_stale', 'medium'],
    ])
  })
})
