import { describe, expect, it } from 'vitest'
import { runNotification } from '../../app/lib/notify'

const run = { runId: 'r 1', symbol: 'US.NVDA', status: 'complete' as const, rating: 'BUY', confidence: 72 }

describe('runNotification', () => {
  it('opens the run on its symbol page, like the push does', () => {
    expect(runNotification(run).url).toBe('/research/US.NVDA?run=r%201')
  })

  it('shares the push tag, so a tab with push on shows one notification per run, not two', () => {
    expect(runNotification(run).tag).toBe('run:r 1')
  })

  it('says a cancelled run was cancelled, not failed', () => {
    const n = runNotification({ ...run, status: 'cancelled', rating: null, confidence: null })
    expect(n.title).toBe('US.NVDA research cancelled')
    expect(runNotification({ ...run, status: 'failed', rating: null, confidence: null }).title).toBe('US.NVDA research failed')
    expect(n.body).not.toMatch(/did not complete/)
  })

  it('shows the verdict of a finished run', () => {
    expect(runNotification(run)).toMatchObject({ title: 'US.NVDA research done', body: 'BUY · conf 72' })
  })
})
