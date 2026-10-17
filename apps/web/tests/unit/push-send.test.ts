import { beforeEach, describe, expect, it, vi } from 'vitest'

const webPush = vi.hoisted(() => ({ sendNotification: vi.fn() }))
vi.mock('web-push', () => ({ default: webPush, ...webPush }))

const { pushConfigFromEnv, sendPush } = await import('../../server/lib/push/web-push')

const cfg = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:me@example.com' }
const sub = { endpoint: 'https://push.example.com/abc', p256dh: 'p', auth: 'a' }
const payload = { title: 'US.NVDA hit 151', body: 'triggered', url: '/portfolio', tag: 'alert:a1' }

beforeEach(() => webPush.sendNotification.mockReset())

describe('pushConfigFromEnv', () => {
  it('needs all three VAPID variables', () => {
    expect(pushConfigFromEnv({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:x@y.z' }))
      .toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:x@y.z' })
    expect(pushConfigFromEnv({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' })).toBeNull()
  })
})

describe('sendPush', () => {
  it('sends a visible JSON payload signed with the VAPID keys', async () => {
    webPush.sendNotification.mockResolvedValue({ statusCode: 201, body: '', headers: {} })
    expect(await sendPush(cfg, sub, payload)).toEqual({ result: 'sent' })
    const [target, body, opts] = webPush.sendNotification.mock.calls[0]!
    expect(target).toEqual({ endpoint: sub.endpoint, keys: { p256dh: 'p', auth: 'a' } })
    expect(JSON.parse(body)).toEqual(payload)
    expect(opts).toMatchObject({ vapidDetails: cfg, urgency: 'high' })
  })

  it('reports a 404 or 410 subscription as gone', async () => {
    for (const statusCode of [404, 410]) {
      webPush.sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode }))
      expect(await sendPush(cfg, sub, payload)).toEqual({ result: 'gone' })
    }
  })

  it('reports other failures as retryable', async () => {
    webPush.sendNotification.mockRejectedValueOnce(Object.assign(new Error('busy'), { statusCode: 503 }))
    expect(await sendPush(cfg, sub, payload)).toEqual({ result: 'error', error: 'push 503: busy' })
  })
})
