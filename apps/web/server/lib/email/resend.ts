import { $fetch } from 'ofetch'

/**
 * Resend over plain HTTP (https://resend.com/docs/api-reference/emails/send-email).
 * No SDK: one POST is all the outbox needs.
 */

const RESEND_URL = 'https://api.resend.com/emails'
const TIMEOUT_MS = 15_000

export interface EmailConfig {
  apiKey: string
  from: string
}

/** Null when RESEND_API_KEY or RESEND_DOMAIN is missing — email is then skipped, not failed. */
export function emailConfigFromEnv(env: Record<string, string | undefined> = process.env): EmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim()
  const domain = env.RESEND_DOMAIN?.trim()
  if (!apiKey || !domain) return null
  return { apiKey, from: `ai-trader <alerts@${domain}>` }
}

/** An inline image the HTML shows with `<img src="cid:<contentId>">`. */
export interface EmailAttachment {
  filename: string
  contentId: string
  contentType: 'image/png'
  contentBase64: string
}

export interface EmailToSend {
  to: string
  subject: string
  html: string
  text: string
  /** Resend replays the first response for a repeated key, so a crash between send and bookkeeping never double-sends. */
  idempotencyKey?: string
  attachments?: EmailAttachment[]
}

export type SendEmailResult =
  | { ok: true; id: string }
  | { ok: false; permanent: boolean; error: string }

export type EmailFetch = (
  url: string,
  opts: { method: 'POST'; headers: Record<string, string>; body: Record<string, unknown>; timeout: number },
) => Promise<{ id: string }>

interface HttpishError { status?: number; statusCode?: number; data?: { message?: string } }

export async function sendEmail(cfg: EmailConfig, email: EmailToSend, fetcher: EmailFetch = $fetch): Promise<SendEmailResult> {
  const headers: Record<string, string> = { 'Authorization': `Bearer ${cfg.apiKey}` }
  if (email.idempotencyKey) headers['Idempotency-Key'] = email.idempotencyKey
  try {
    const res = await fetcher(RESEND_URL, {
      method: 'POST',
      headers,
      body: {
        from: cfg.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        // https://resend.com/docs/dashboard/emails/embed-inline-images
        ...(email.attachments?.length
          ? { attachments: email.attachments.map(a => ({ filename: a.filename, content: a.contentBase64, content_id: a.contentId, content_type: a.contentType })) }
          : {}),
      },
      timeout: TIMEOUT_MS,
    })
    return { ok: true, id: res.id }
  }
  catch (err: unknown) {
    const e = (err ?? {}) as HttpishError
    const status = e.status ?? e.statusCode
    const detail = e.data?.message ?? (err instanceof Error ? err.message : String(err))
    if (typeof status === 'number') {
      // 408/409 (concurrent idempotent request)/429 and 5xx can succeed later.
      const permanent = status >= 400 && status < 500 && ![408, 409, 429].includes(status)
      return { ok: false, permanent, error: `Resend ${status}: ${detail}` }
    }
    return { ok: false, permanent: false, error: `Resend unreachable: ${detail}` }
  }
}
