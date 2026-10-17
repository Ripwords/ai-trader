import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from './support/fake-db'
import { dueAtProblem, reminderCreateSchema, shapeReminderRow } from '../../server/lib/reminders-core'

let fake = createFakeDb()
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))
vi.mock('../../server/lib/notification-settings', () => ({
  getNotificationSettings: async () => ({ email: null, timezone: 'Asia/Kuala_Lumpur', priceAlerts: true, reminders: true, researchRuns: true, chatReplies: true }),
}))

const { dispatchDueReminders } = await import('../../server/lib/reminders')

const NOW = new Date('2026-10-17T01:00:00.000Z')

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  createdAt: new Date('2026-10-16T00:00:00.000Z'),
  dueAt: new Date('2026-10-17T00:59:00.000Z'),
  message: 'Check NVDA earnings',
  symbol: 'US.NVDA',
  status: 'sent',
  sentAt: NOW,
  ...over,
})

beforeEach(() => {
  fake = createFakeDb()
})

describe('reminder validation', () => {
  it('requires an ISO due time with an offset', () => {
    expect(reminderCreateSchema.safeParse({ dueAt: '2026-10-17T09:00:00+08:00', message: 'hi' }).success).toBe(true)
    expect(reminderCreateSchema.safeParse({ dueAt: '2026-10-17 09:00', message: 'hi' }).success).toBe(false)
    expect(reminderCreateSchema.safeParse({ dueAt: '2026-10-17T09:00:00+08:00', message: '   ' }).success).toBe(false)
  })

  it('refuses a due time in the past or more than a year out', () => {
    expect(dueAtProblem(new Date(NOW.getTime() + 60_000), NOW)).toBeNull()
    expect(dueAtProblem(new Date(NOW.getTime() - 30_000), NOW)).toBeNull()
    expect(dueAtProblem(new Date(NOW.getTime() - 10 * 60_000), NOW)).toMatch(/past/)
    expect(dueAtProblem(new Date(NOW.getTime() + 400 * 86_400_000), NOW)).toMatch(/year/)
    expect(dueAtProblem(new Date('nope'), NOW)).toMatch(/valid/)
  })

  it('shapes a row for the wire', () => {
    expect(shapeReminderRow(dbRow())).toMatchObject({ id: 'r1', dueAt: '2026-10-17T00:59:00.000Z', sentAt: NOW.toISOString(), status: 'sent' })
  })
})

describe('dispatchDueReminders', () => {
  it('marks due reminders sent, guarded on scheduled, and enqueues one notification each', async () => {
    fake = createFakeDb(() => [], {
      updateReturning: u => u.table === 'reminders' ? [dbRow(), dbRow({ id: 'r2', symbol: null })] : [],
      insertReturning: () => [{ id: 'n' }],
    })
    const sent = await dispatchDueReminders(NOW)
    expect(sent.map(r => r.id)).toEqual(['r1', 'r2'])

    const update = fake.updates.find(u => u.table === 'reminders')!
    expect(update.set).toMatchObject({ status: 'sent', sentAt: NOW })
    expect(update.params).toContain('scheduled')

    const queued = fake.inserts.filter(i => i.table === 'notifications')
    expect(queued.map(q => q.values.dedupeKey)).toEqual(['reminder:r1', 'reminder:r2'])
    expect(queued[0]!.values).toMatchObject({ kind: 'reminder', url: '/research/US.NVDA' })
    expect(String(queued[0]!.values.bodyText)).toContain('08:59')
  })

  it('enqueues nothing when no reminder is due', async () => {
    expect(await dispatchDueReminders(NOW)).toEqual([])
    expect(fake.inserts).toEqual([])
  })
})
