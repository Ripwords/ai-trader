import { describe, expect, it, vi } from 'vitest'
import { createFakeDb } from './support/fake-db'

let fake = createFakeDb()
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))

const { getNotificationSettings } = await import('../../server/lib/notification-settings')

describe('getNotificationSettings', () => {
  it('reads settings saved before the chat-replies toggle existed with it on', async () => {
    const stored = { email: 'me@example.com', timezone: 'Asia/Kuala_Lumpur', priceAlerts: false, reminders: true, researchRuns: false }
    fake = createFakeDb(table => table === 'app_settings' ? [{ value: stored }] : [])
    expect(await getNotificationSettings()).toEqual({ ...stored, chatReplies: true })
  })
})
