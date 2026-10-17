import { describe, expect, it, vi } from 'vitest'

const dispatch = vi.hoisted(() => {
  const gates: Array<() => void> = []
  return {
    gates,
    fn: vi.fn(() => new Promise<{ processed: number; sent: number; failed: number; skipped: number; pending: number }>((resolve) => {
      gates.push(() => resolve({ processed: 0, sent: 0, failed: 0, skipped: 0, pending: 0 }))
    })),
  }
})
vi.mock('../../server/lib/notifications-dispatch', () => ({ dispatchNotifications: dispatch.fn }))
vi.mock('../../db/client', () => ({ getDb: () => ({}) }))

const { drainNotifications } = await import('../../server/lib/notifications')

const settle = () => new Promise(r => setTimeout(r, 0))

describe('drainNotifications', () => {
  it('joins a running drain and makes it go round once more instead of running two at once', async () => {
    const first = drainNotifications()
    const second = drainNotifications()
    const third = drainNotifications()
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(dispatch.fn).toHaveBeenCalledTimes(1)

    dispatch.gates.shift()!()
    await settle()
    // The joined calls asked for another pass: rows enqueued after the first claim.
    expect(dispatch.fn).toHaveBeenCalledTimes(2)
    dispatch.gates.shift()!()
    await first
    expect(dispatch.fn).toHaveBeenCalledTimes(2)

    // Idle again: the next call starts a fresh drain.
    const next = drainNotifications()
    expect(next).not.toBe(first)
    dispatch.gates.shift()!()
    await next
    expect(dispatch.fn).toHaveBeenCalledTimes(3)
  })
})
