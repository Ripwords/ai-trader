import { describe, expect, it, vi } from 'vitest'
import type { NotificationMessage } from '../../server/lib/notifications-messages'

const dispatch = vi.hoisted(() => vi.fn(async () => ({ processed: 1, sent: 1, failed: 0, skipped: 0, pending: 0 })))
const inserted = vi.hoisted(() => ({ rows: [{ id: 'n1' }] as Array<{ id: string }> }))
vi.mock('../../server/lib/notifications-dispatch', () => ({ dispatchNotifications: dispatch }))
vi.mock('../../db/client', () => ({
  getDb: () => ({
    insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => inserted.rows }) }) }),
  }),
}))

const { enqueueNotificationSafely } = await import('../../server/lib/notifications')
const message: NotificationMessage = { kind: 'research_run', dedupeKey: 'run:r1', subject: 'NVDA research finished', bodyText: 'x', bodyHtml: '<p>x</p>', url: null }

describe('enqueueNotificationSafely', () => {
  it('starts the sender at once, so a finished research run or chat reply is pushed in seconds, not on the next minute', async () => {
    await enqueueNotificationSafely(message)
    await new Promise(r => setTimeout(r, 0))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not start the sender when the row was already queued', async () => {
    dispatch.mockClear()
    inserted.rows = []
    await enqueueNotificationSafely(message)
    await new Promise(r => setTimeout(r, 0))
    expect(dispatch).not.toHaveBeenCalled()
  })
})
