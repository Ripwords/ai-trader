import { describe, expect, it, vi } from 'vitest'
import { dispatchNotifications, type DispatchDeps, type OutboxRow } from '../../server/lib/notifications-dispatch'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../types/notifications'
import type { DeliveryUpdate } from '../../server/lib/notifications-core'

const NOW = new Date('2026-10-17T01:00:00.000Z')

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: 'n1',
  kind: 'price_alert',
  dedupeKey: 'alert:a1',
  subject: 'US.NVDA hit 151',
  bodyText: 'triggered',
  bodyHtml: '<p>triggered</p>',
  url: '/portfolio',
  attachments: null,
  emailStatus: 'pending',
  pushStatus: 'pending',
  attempts: 0,
  sentAt: null,
  ...over,
})

function deps(over: Partial<DispatchDeps> = {}, rows: OutboxRow[] = [row()]) {
  const saved: Array<{ id: string; update: DeliveryUpdate }> = []
  const d: DispatchDeps = {
    now: () => NOW,
    claimDue: vi.fn(async () => rows),
    saveDelivery: vi.fn(async (id: string, update: DeliveryUpdate) => { saved.push({ id, update }) }),
    getSettings: vi.fn(async () => ({ ...DEFAULT_NOTIFICATION_SETTINGS, email: 'me@example.com' })),
    emailConfig: { apiKey: 're_x', from: 'ai-trader <alerts@x.com>' },
    pushConfig: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:me@example.com' },
    listSubscriptions: vi.fn(async () => [{ id: 's1', endpoint: 'https://push/1', p256dh: 'p', auth: 'a' }]),
    deleteSubscription: vi.fn(async () => {}),
    markSubscriptionOk: vi.fn(async () => {}),
    sendEmail: vi.fn(async () => ({ ok: true as const, id: 'email-1' })),
    sendPush: vi.fn(async () => ({ result: 'sent' as const })),
    ...over,
  }
  return { d, saved }
}

describe('dispatchNotifications', () => {
  it('sends on both channels and marks the row sent', async () => {
    const { d, saved } = deps()
    const summary = await dispatchNotifications(d)
    expect(summary).toMatchObject({ processed: 1, sent: 1 })
    expect(d.sendEmail).toHaveBeenCalledWith(d.emailConfig, expect.objectContaining({ to: 'me@example.com', subject: 'US.NVDA hit 151', idempotencyKey: 'notification:n1' }))
    expect(d.sendPush).toHaveBeenCalledWith(d.pushConfig, expect.objectContaining({ endpoint: 'https://push/1' }), expect.objectContaining({ title: 'US.NVDA hit 151', url: '/portfolio' }))
    expect(d.markSubscriptionOk).toHaveBeenCalledWith('s1', NOW)
    expect(saved[0]!.update).toMatchObject({ status: 'sent', emailStatus: 'sent', pushStatus: 'sent' })
  })

  it('forwards stored attachments to the email', async () => {
    const attachments = [{ filename: 'c.png', contentId: 'price-chart', contentType: 'image/png' as const, contentBase64: 'iVBORw0K' }]
    const { d } = deps({}, [row({ attachments })])
    await dispatchNotifications(d)
    expect(d.sendEmail).toHaveBeenCalledWith(d.emailConfig, expect.objectContaining({ attachments }))
  })

  it('skips email with no recipient without failing push', async () => {
    const { d, saved } = deps({ getSettings: vi.fn(async () => DEFAULT_NOTIFICATION_SETTINGS) })
    await dispatchNotifications(d)
    expect(d.sendEmail).not.toHaveBeenCalled()
    expect(saved[0]!.update).toMatchObject({ status: 'sent', emailStatus: 'skipped', pushStatus: 'sent' })
  })

  it('skips the whole row when its category is off', async () => {
    const { d, saved } = deps({ getSettings: vi.fn(async () => ({ ...DEFAULT_NOTIFICATION_SETTINGS, email: 'me@example.com', priceAlerts: false })) })
    await dispatchNotifications(d)
    expect(d.sendEmail).not.toHaveBeenCalled()
    expect(d.sendPush).not.toHaveBeenCalled()
    expect(saved[0]!.update.status).toBe('skipped')
  })

  it('deletes a gone subscription and skips push when no device is left', async () => {
    const { d, saved } = deps({ sendPush: vi.fn(async () => ({ result: 'gone' as const })) })
    await dispatchNotifications(d)
    expect(d.deleteSubscription).toHaveBeenCalledWith('s1')
    expect(saved[0]!.update).toMatchObject({ emailStatus: 'sent', pushStatus: 'skipped', status: 'sent' })
  })

  it('retries only push when push fails and email went out', async () => {
    const { d, saved } = deps({ sendPush: vi.fn(async () => ({ result: 'error' as const, error: 'push 503: busy' })) })
    await dispatchNotifications(d)
    expect(saved[0]!.update).toMatchObject({ status: 'pending', emailStatus: 'sent', pushStatus: 'pending', attempts: 1 })

    // The retry sees email already sent and does not send it again.
    const retry = deps({}, [row({ emailStatus: 'sent', pushStatus: 'pending', attempts: 1, sentAt: NOW })])
    await dispatchNotifications(retry.d)
    expect(retry.d.sendEmail).not.toHaveBeenCalled()
    expect(retry.saved[0]!.update).toMatchObject({ status: 'sent', pushStatus: 'sent', attempts: 2 })
  })

  it('counts push as delivered when one of several devices took it', async () => {
    const { d, saved } = deps({
      listSubscriptions: vi.fn(async () => [
        { id: 's1', endpoint: 'https://push/1', p256dh: 'p', auth: 'a' },
        { id: 's2', endpoint: 'https://push/2', p256dh: 'p', auth: 'a' },
      ]),
      sendPush: vi.fn(async (_c, t) => t.endpoint.endsWith('1') ? { result: 'error' as const, error: 'x' } : { result: 'sent' as const }),
    })
    await dispatchNotifications(d)
    expect(saved[0]!.update.pushStatus).toBe('sent')
  })

  it('records a permanent email rejection as failed', async () => {
    const { d, saved } = deps({ sendEmail: vi.fn(async () => ({ ok: false as const, permanent: true, error: 'Resend 422: bad' })) })
    await dispatchNotifications(d)
    expect(saved[0]!.update).toMatchObject({ emailStatus: 'failed', pushStatus: 'sent', status: 'sent' })
    expect(saved[0]!.update.lastError).toMatch(/Resend 422/)
  })

  it('keeps going when one row throws', async () => {
    const { d, saved } = deps({}, [row({ id: 'n1' }), row({ id: 'n2' })])
    let first = true
    d.sendEmail = vi.fn(async () => {
      if (first) { first = false; throw new Error('kaboom') }
      return { ok: true as const, id: 'e' }
    })
    await expect(dispatchNotifications(d)).resolves.toMatchObject({ processed: 2 })
    expect(saved.map(s => s.id)).toContain('n2')
  })

  it('does nothing when no row is due', async () => {
    const { d } = deps({}, [])
    expect(await dispatchNotifications(d)).toMatchObject({ processed: 0 })
    expect(d.getSettings).not.toHaveBeenCalled()
  })
})
