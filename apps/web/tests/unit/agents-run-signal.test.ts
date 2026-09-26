import { describe, expect, it } from 'vitest'
import { notifyRun, runVersion, waitForRun } from '../../server/lib/agents/run-signal'

const outcome = (p: Promise<void>, ms = 200) =>
  Promise.race([p.then(() => 'woken' as const), new Promise<'timeout'>(r => setTimeout(() => r('timeout'), ms))])

describe('run signal', () => {
  it('wakes a waiter when the run is notified', async () => {
    const wait = waitForRun('sig-a', runVersion('sig-a'), 10_000)
    notifyRun('sig-a')
    expect(await outcome(wait)).toBe('woken')
  })

  it('returns at once when the run changed since the version was read', async () => {
    const seen = runVersion('sig-b')
    notifyRun('sig-b')
    expect(await outcome(waitForRun('sig-b', seen, 10_000), 20)).toBe('woken')
  })

  it('falls back to the timeout without a notification', async () => {
    const started = Date.now()
    await waitForRun('sig-c', runVersion('sig-c'), 15)
    expect(Date.now() - started).toBeGreaterThanOrEqual(10)
  })

  it('resolves when the signal aborts', async () => {
    const ac = new AbortController()
    const wait = waitForRun('sig-d', runVersion('sig-d'), 10_000, ac.signal)
    ac.abort()
    expect(await outcome(wait)).toBe('woken')
  })

  it('forgets a run after its final notification and still wakes its waiters', async () => {
    notifyRun('sig-e')
    const wait = waitForRun('sig-e', runVersion('sig-e'), 10_000)
    notifyRun('sig-e', { final: true })
    expect(await outcome(wait)).toBe('woken')
    expect(runVersion('sig-e')).toBe(0)
  })
})
