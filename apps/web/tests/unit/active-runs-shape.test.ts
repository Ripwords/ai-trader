import { describe, it, expect } from 'vitest'
import { shapeActiveRuns } from '../../server/lib/agents/runs-query'

describe('shapeActiveRuns', () => {
  it('maps running rows and joins decisions onto finished rows', () => {
    const out = shapeActiveRuns(
      [{ id: 'a', symbol: 'NVDA', startedAt: new Date('2026-06-28T10:00:00Z') }],
      [{ id: 'b', symbol: 'TSLA', status: 'complete', rating: 'BUY', confidence: 72 },
       { id: 'c', symbol: 'MU', status: 'failed', rating: null, confidence: null }],
    )
    expect(out.active).toEqual([{ runId: 'a', symbol: 'NVDA', startedAt: '2026-06-28T10:00:00.000Z' }])
    expect(out.recentlyFinished).toEqual([
      { runId: 'b', symbol: 'TSLA', status: 'complete', rating: 'BUY', confidence: 72 },
      { runId: 'c', symbol: 'MU', status: 'failed', rating: null, confidence: null },
    ])
  })

  it('handles empty inputs', () => {
    expect(shapeActiveRuns([], [])).toEqual({ active: [], recentlyFinished: [] })
  })
})
