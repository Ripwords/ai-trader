import { describe, it, expect } from 'vitest'
import { computeNotifications } from '../../composables/useActiveRuns'

const resp = (finished: Array<{ runId: string; symbol: string; status: 'complete' | 'failed'; rating: string | null; confidence: number | null }>) =>
  ({ active: [], recentlyFinished: finished })

describe('computeNotifications', () => {
  it('returns finished runs not yet notified', () => {
    const r = computeNotifications(
      resp([{ runId: 'a', symbol: 'NVDA', status: 'complete', rating: 'BUY', confidence: 72 }]),
      new Set(),
    )
    expect(r.toNotify.map(x => x.runId)).toEqual(['a'])
    expect(r.nextNotified).toContain('a')
  })

  it('does not re-notify an already-notified run', () => {
    const r = computeNotifications(
      resp([{ runId: 'a', symbol: 'NVDA', status: 'complete', rating: 'BUY', confidence: 72 }]),
      new Set(['a']),
    )
    expect(r.toNotify).toEqual([])
    expect(r.nextNotified).toContain('a')
  })

  it('caps the persisted notified set to the most recent ids', () => {
    const r = computeNotifications(resp([]), new Set(['old1', 'old2', 'old3']), 2)
    expect(r.nextNotified).toHaveLength(2)
  })
})
