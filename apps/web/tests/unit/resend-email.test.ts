import { describe, expect, it, vi } from 'vitest'
import { emailConfigFromEnv, sendEmail, type EmailFetch } from '../../server/lib/email/resend'

const cfg = { apiKey: 're_test', from: 'ai-trader <alerts@trader.example.com>' }
const email = { to: 'me@example.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi', idempotencyKey: 'alert:a1' }

describe('emailConfigFromEnv', () => {
  it('builds the sender from RESEND_DOMAIN', () => {
    expect(emailConfigFromEnv({ RESEND_API_KEY: 're_x', RESEND_DOMAIN: 'trader.example.com' }))
      .toEqual({ apiKey: 're_x', from: 'ai-trader <alerts@trader.example.com>' })
  })

  it('is null when either variable is missing or blank', () => {
    expect(emailConfigFromEnv({ RESEND_API_KEY: 're_x' })).toBeNull()
    expect(emailConfigFromEnv({ RESEND_API_KEY: ' ', RESEND_DOMAIN: 'trader.example.com' })).toBeNull()
  })
})

describe('sendEmail', () => {
  it('POSTs to Resend with the bearer and idempotency key', async () => {
    const fetcher = vi.fn<EmailFetch>(async () => ({ id: 'email-123' }))
    const res = await sendEmail(cfg, email, fetcher)
    expect(res).toEqual({ ok: true, id: 'email-123' })
    const [url, opts] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(opts.method).toBe('POST')
    expect(opts.headers).toMatchObject({ 'Authorization': 'Bearer re_test', 'Idempotency-Key': 'alert:a1' })
    expect(opts.body).toEqual({ from: cfg.from, to: ['me@example.com'], subject: 'Hi', html: '<p>hi</p>', text: 'hi' })
  })

  it('sends inline attachments in Resend\'s shape', async () => {
    const fetcher = vi.fn<EmailFetch>(async () => ({ id: 'email-1' }))
    const attachments = [{ filename: 'chart.png', contentId: 'chart-a1', contentType: 'image/png' as const, contentBase64: 'iVBORw0K' }]
    await sendEmail(cfg, { ...email, attachments }, fetcher)
    expect(fetcher.mock.calls[0]![1].body.attachments).toEqual([
      { filename: 'chart.png', content: 'iVBORw0K', content_id: 'chart-a1', content_type: 'image/png' },
    ])
  })

  it('treats a 4xx rejection as permanent', async () => {
    const err = Object.assign(new Error('422'), { status: 422, data: { message: 'invalid to' } })
    const res = await sendEmail(cfg, email, vi.fn<EmailFetch>(async () => { throw err }))
    expect(res).toEqual({ ok: false, permanent: true, error: 'Resend 422: invalid to' })
  })

  it('retries rate limits, server errors and network failures', async () => {
    for (const err of [Object.assign(new Error('x'), { status: 429 }), Object.assign(new Error('x'), { status: 503 }), new Error('ECONNRESET')]) {
      const res = await sendEmail(cfg, email, vi.fn<EmailFetch>(async () => { throw err }))
      expect(res).toMatchObject({ ok: false, permanent: false })
    }
  })
})
