import { describe, expect, it } from 'vitest'
import {
  KIND_CHANNELS,
  MAX_ATTEMPTS,
  NOTIFICATION_KINDS,
  backoffMs,
  categoryEnabled,
  planDelivery,
  rollUpStatus,
  settleDelivery,
  type DeliveryContext,
} from '../../server/lib/notifications-core'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../types/notifications'

const NOW = new Date('2026-10-17T01:00:00.000Z')

const ctx = (over: Partial<DeliveryContext> = {}): DeliveryContext => ({
  settings: { ...DEFAULT_NOTIFICATION_SETTINGS, email: 'me@example.com' },
  emailConfigured: true,
  pushConfigured: true,
  subscriptionCount: 1,
  ...over,
})

const pendingRow = { kind: 'price_alert' as const, emailStatus: 'pending' as const, pushStatus: 'pending' as const }

describe('categoryEnabled', () => {
  it('maps each kind to its toggle', () => {
    const s = { ...DEFAULT_NOTIFICATION_SETTINGS, priceAlerts: false }
    expect(categoryEnabled(s, 'price_alert')).toBe(false)
    expect(categoryEnabled(s, 'reminder')).toBe(true)
    expect(categoryEnabled({ ...s, researchRuns: false }, 'research_run')).toBe(false)
    expect(categoryEnabled(s, 'chat_reply')).toBe(true)
    expect(categoryEnabled({ ...s, chatReplies: false }, 'chat_reply')).toBe(false)
  })

  it('always lets a test notification through', () => {
    const s = { ...DEFAULT_NOTIFICATION_SETTINGS, priceAlerts: false, reminders: false, researchRuns: false, chatReplies: false }
    expect(categoryEnabled(s, 'test')).toBe(true)
  })
})

describe('KIND_CHANNELS', () => {
  it('gives every kind at least one channel', () => {
    for (const kind of NOTIFICATION_KINDS) expect(KIND_CHANNELS[kind].length).toBeGreaterThan(0)
  })

  it('sends price alerts, reminders and tests by email and push, the rest by push only', () => {
    expect(KIND_CHANNELS).toEqual({
      price_alert: ['email', 'push'],
      reminder: ['email', 'push'],
      test: ['email', 'push'],
      research_run: ['push'],
      chat_reply: ['push'],
    })
  })
})

describe('backoffMs', () => {
  it('grows with each failed attempt and is capped', () => {
    expect(backoffMs(1)).toBe(60_000)
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1))
    expect(backoffMs(3)).toBeGreaterThan(backoffMs(2))
    expect(backoffMs(50)).toBe(backoffMs(40))
  })
})

describe('rollUpStatus', () => {
  it('stays pending while any channel is pending', () => {
    expect(rollUpStatus('sent', 'pending')).toBe('pending')
  })
  it('is sent when any channel delivered', () => {
    expect(rollUpStatus('sent', 'failed')).toBe('sent')
    expect(rollUpStatus('skipped', 'sent')).toBe('sent')
  })
  it('is failed when nothing delivered and something failed', () => {
    expect(rollUpStatus('failed', 'skipped')).toBe('failed')
  })
  it('is skipped when every channel was skipped', () => {
    expect(rollUpStatus('skipped', 'skipped')).toBe('skipped')
  })
})

describe('planDelivery', () => {
  it('sends on both channels when everything is configured', () => {
    expect(planDelivery(pendingRow, ctx())).toEqual({ email: { action: 'send' }, push: { action: 'send' } })
  })

  it('skips both channels when the category is off', () => {
    const plan = planDelivery(pendingRow, ctx({ settings: { ...DEFAULT_NOTIFICATION_SETTINGS, email: 'me@example.com', priceAlerts: false } }))
    expect(plan.email).toMatchObject({ action: 'skip' })
    expect(plan.push).toMatchObject({ action: 'skip' })
  })

  it('skips email with no recipient or no API key, independently of push', () => {
    expect(planDelivery(pendingRow, ctx({ settings: DEFAULT_NOTIFICATION_SETTINGS }))).toMatchObject({
      email: { action: 'skip', reason: expect.stringMatching(/recipient/) },
      push: { action: 'send' },
    })
    expect(planDelivery(pendingRow, ctx({ emailConfigured: false })).email).toMatchObject({ action: 'skip', reason: expect.stringMatching(/RESEND/) })
  })

  it('skips push with no VAPID keys or no subscribed device', () => {
    expect(planDelivery(pendingRow, ctx({ pushConfigured: false })).push).toMatchObject({ action: 'skip', reason: expect.stringMatching(/VAPID/) })
    expect(planDelivery(pendingRow, ctx({ subscriptionCount: 0 })).push).toMatchObject({ action: 'skip', reason: expect.stringMatching(/device/) })
  })

  it('skips email as push-only for research runs and chat replies', () => {
    for (const kind of ['research_run', 'chat_reply'] as const) {
      expect(planDelivery({ ...pendingRow, kind }, ctx())).toEqual({
        email: { action: 'skip', reason: 'push-only notification' },
        push: { action: 'send' },
      })
    }
  })

  it('reports the push-only reason even when email is not configured', () => {
    expect(planDelivery({ ...pendingRow, kind: 'chat_reply' }, ctx({ emailConfigured: false })).email)
      .toEqual({ action: 'skip', reason: 'push-only notification' })
  })

  it('leaves a channel that already settled alone', () => {
    expect(planDelivery({ ...pendingRow, emailStatus: 'sent' }, ctx()).email).toEqual({ action: 'none' })
  })
})

describe('settleDelivery', () => {
  const row = { emailStatus: 'pending' as const, pushStatus: 'pending' as const, attempts: 0, sentAt: null }

  it('marks the row sent when both channels delivered', () => {
    const u = settleDelivery(row, { email: { result: 'sent' }, push: { result: 'sent' } }, NOW)
    expect(u).toMatchObject({ status: 'sent', emailStatus: 'sent', pushStatus: 'sent', attempts: 1, lastError: null, sentAt: NOW })
  })

  it('keeps a delivered email sent while a failing push retries with backoff', () => {
    const u = settleDelivery(row, { email: { result: 'sent' }, push: { result: 'retry', error: 'HTTP 500' } }, NOW)
    expect(u).toMatchObject({ status: 'pending', emailStatus: 'sent', pushStatus: 'pending', attempts: 1, sentAt: NOW })
    expect(u.nextAttemptAt.getTime()).toBe(NOW.getTime() + backoffMs(1))
    expect(u.lastError).toMatch(/push: HTTP 500/)

    // Next attempt only touches push; the email status is carried over untouched.
    const again = settleDelivery({ ...u, sentAt: NOW }, { push: { result: 'sent' } }, NOW)
    expect(again).toMatchObject({ status: 'sent', emailStatus: 'sent', pushStatus: 'sent', attempts: 2 })
  })

  it('gives up after the last attempt', () => {
    const u = settleDelivery({ ...row, emailStatus: 'skipped', attempts: MAX_ATTEMPTS - 1 }, { push: { result: 'retry', error: 'timeout' } }, NOW)
    expect(u).toMatchObject({ status: 'failed', pushStatus: 'failed', attempts: MAX_ATTEMPTS })
  })

  it('fails a permanent error at once', () => {
    const u = settleDelivery(row, { email: { result: 'failed', error: '422 invalid' }, push: { result: 'skipped', reason: 'no device' } }, NOW)
    expect(u).toMatchObject({ status: 'failed', emailStatus: 'failed', pushStatus: 'skipped', attempts: 1 })
  })

  it('does not count an attempt when every channel was skipped', () => {
    const u = settleDelivery(row, { email: { result: 'skipped', reason: 'no recipient' }, push: { result: 'skipped', reason: 'no device' } }, NOW)
    expect(u).toMatchObject({ status: 'skipped', attempts: 0, sentAt: null })
    expect(u.lastError).toMatch(/email skipped: no recipient/)
  })
})
