import { describe, expect, it } from 'vitest'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { notifications, pushSubscriptions, reminders } from '../../db/schema'

describe('notifications schema', () => {
  it('is an outbox with a unique dedupe key and per-channel status', () => {
    expect(getTableName(notifications)).toBe('notifications')
    const cols = getTableColumns(notifications)
    expect(Object.keys(cols)).toEqual(expect.arrayContaining([
      'id', 'createdAt', 'kind', 'dedupeKey', 'subject', 'bodyText', 'bodyHtml', 'url',
      'status', 'emailStatus', 'pushStatus', 'attempts', 'nextAttemptAt', 'lastError', 'sentAt',
    ]))
    expect(cols.dedupeKey.isUnique).toBe(true)
    expect(cols.status.default).toBe('pending')
    expect(cols.emailStatus.default).toBe('pending')
    expect(cols.pushStatus.default).toBe('pending')
    expect(cols.attempts.default).toBe(0)
    expect(cols.sentAt.notNull).toBe(false)
  })

  it('stores inline email attachments as nullable jsonb', () => {
    const cols = getTableColumns(notifications)
    expect(cols.attachments.getSQLType()).toBe('jsonb')
    expect(cols.attachments.notNull).toBe(false)
  })
})

describe('reminders schema', () => {
  it('stores a one-shot reminder with a timezone-aware due time', () => {
    expect(getTableName(reminders)).toBe('reminders')
    const cols = getTableColumns(reminders)
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(['id', 'createdAt', 'dueAt', 'message', 'symbol', 'status', 'sentAt']))
    expect(cols.dueAt.notNull).toBe(true)
    expect(cols.dueAt.withTimezone).toBe(true)
    expect(cols.status.default).toBe('scheduled')
    expect(cols.symbol.notNull).toBe(false)
  })
})

describe('push_subscriptions schema', () => {
  it('keys a device by its unique endpoint', () => {
    expect(getTableName(pushSubscriptions)).toBe('push_subscriptions')
    const cols = getTableColumns(pushSubscriptions)
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(['id', 'endpoint', 'p256dh', 'auth', 'userAgent', 'createdAt', 'lastSuccessAt']))
    expect(cols.endpoint.isUnique).toBe(true)
  })
})
