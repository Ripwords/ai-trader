import { describe, it, expect } from 'vitest'
import { summarizeThesis } from '../../server/llm/research/thesis'

const now = Date.parse('2026-06-28T00:00:00Z')

describe('summarizeThesis', () => {
  it('reports none/empty for a symbol with no runs', () => {
    const s = summarizeThesis('NVDA', [], null, now)
    expect(s).toMatchObject({ latest: null, history: [], confidenceTrend: 'n/a', staleness: 'none', realizedAlpha: null })
  })
  it('marks fresh and rising confidence', () => {
    const runs = [
      { runId: 'b', rating: 'BUY', confidence: 80, finishedAt: '2026-06-27T00:00:00Z' },
      { runId: 'a', rating: 'BUY', confidence: 60, finishedAt: '2026-06-20T00:00:00Z' },
    ] // newest first
    const s = summarizeThesis('NVDA', runs, 6.5, now)
    expect(s.latest?.runId).toBe('b')
    expect(s.confidenceTrend).toBe('up')
    expect(s.staleness).toBe('fresh')
    expect(s.realizedAlpha).toBe(6.5)
  })
  it('marks stale when the latest run is older than 21 days', () => {
    const runs = [{ runId: 'a', rating: 'HOLD', confidence: 50, finishedAt: '2026-05-01T00:00:00Z' }]
    expect(summarizeThesis('NVDA', runs, null, now).staleness).toBe('stale')
  })
  it('flat when confidence is unchanged, n/a when <2 have confidence', () => {
    expect(summarizeThesis('X', [{ runId: 'a', rating: 'BUY', confidence: 70, finishedAt: '2026-06-27T00:00:00Z' }], null, now).confidenceTrend).toBe('n/a')
    const flat = [
      { runId: 'b', rating: 'BUY', confidence: 70, finishedAt: '2026-06-27T00:00:00Z' },
      { runId: 'a', rating: 'BUY', confidence: 70, finishedAt: '2026-06-20T00:00:00Z' },
    ]
    expect(summarizeThesis('X', flat, null, now).confidenceTrend).toBe('flat')
  })
})
