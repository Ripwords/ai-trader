import { describe, it, expect } from 'vitest'
import { summarizeRunRow } from '../../server/lib/agents/runs-query'

describe('summarizeRunRow', () => {
  it('maps a joined run+decision row into a summary', () => {
    const out = summarizeRunRow({
      id: 'r1', symbol: 'NVDA', status: 'complete',
      finishedAt: new Date('2026-06-28T12:00:00Z'),
      rating: 'BUY', confidence: 72,
    })
    expect(out).toEqual({
      runId: 'r1', symbol: 'NVDA', status: 'complete',
      finishedAt: '2026-06-28T12:00:00.000Z', rating: 'BUY', confidence: 72,
    })
  })

  it('tolerates a run with no decision', () => {
    const out = summarizeRunRow({
      id: 'r2', symbol: 'MU', status: 'failed', finishedAt: null, rating: null, confidence: null,
    })
    expect(out).toEqual({
      runId: 'r2', symbol: 'MU', status: 'failed', finishedAt: null, rating: null, confidence: null,
    })
  })
})
