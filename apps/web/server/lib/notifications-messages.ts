/**
 * What each notification says. Pure: producers build the message once at
 * enqueue time and the outbox stores the rendered subject, text and HTML, so
 * a retry sends exactly what the first attempt would have.
 */
import { randomUUID } from 'node:crypto'
import type { EmailAttachment } from './email/resend'
import type { NotificationKind } from './notifications-core'
import type { Reminder } from './reminders-core'
import { formatInZone } from '../../types/zoned-time'

export interface NotificationMessage {
  kind: NotificationKind
  dedupeKey: string
  subject: string
  bodyText: string
  bodyHtml: string
  /** App path a push notification or email link opens. */
  url: string | null
  /** Inline images the HTML references as cid:<contentId>. Rendered once here so retries send identical bytes. */
  attachments?: EmailAttachment[]
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function absolute(path: string | null, appUrl: string | null): string | null {
  if (!path || !appUrl) return null
  return `${appUrl.replace(/\/+$/, '')}${path}`
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
}

/** LLM rationales arrive as markdown; an email excerpt wants plain sentences. */
function stripMarkdown(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export const EMAIL_FONT = '-apple-system,Segoe UI,Helvetica,Arial,sans-serif'
export const EMAIL_MONO = 'ui-monospace,Menlo,monospace'

/** Page and card every email shares. `inner` is trusted HTML. */
export function emailShell(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>`
    + `<body style="margin:0;padding:24px 12px;background:#f4f2ee;font-family:${EMAIL_FONT}">`
    + `<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:24px;border:1px solid #e3dfd6">`
    + inner
    + `</div></body></html>`
}

export function emailEyebrow(text: string): string {
  return `<div style="font-family:${EMAIL_MONO};font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#8a8478;margin-bottom:12px">${escapeHtml(text)}</div>`
}

/** Minimal inline-styled email: a heading, paragraphs, an optional button link. */
export function renderEmailHtml(opts: { heading: string; paragraphs: string[]; link?: { href: string; label: string } | null }): string {
  const p = opts.paragraphs
    .map(t => `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#2b2f36;white-space:pre-wrap">${escapeHtml(t)}</p>`)
    .join('')
  const link = opts.link
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(opts.link.href)}" style="display:inline-block;padding:10px 16px;background:#0d0f12;color:#d4a96a;text-decoration:none;font-family:${EMAIL_MONO};font-size:12px;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(opts.link.label)}</a></p>`
    : ''
  return emailShell(
    emailEyebrow('ai·trader')
    + `<h1 style="margin:0 0 16px;font-size:18px;line-height:1.3;color:#0d0f12">${escapeHtml(opts.heading)}</h1>`
    + p + link,
  )
}

function build(
  kind: NotificationKind,
  dedupeKey: string,
  subject: string,
  paragraphs: string[],
  url: string | null,
  appUrl: string | null,
  linkLabel: string,
): NotificationMessage {
  const href = absolute(url, appUrl)
  return {
    kind,
    dedupeKey,
    subject,
    bodyText: [...paragraphs, ...(href ? [href] : [])].join('\n\n'),
    bodyHtml: renderEmailHtml({ heading: subject, paragraphs, link: href ? { href, label: linkLabel } : null }),
    url,
  }
}

export function reminderMessage(reminder: Reminder, timeZone: string, appUrl: string | null): NotificationMessage {
  const subject = clip(`Reminder: ${reminder.message.replace(/\s+/g, ' ')}`, 90)
  const paragraphs = [reminder.message, `Due ${formatInZone(reminder.dueAt, timeZone)}${reminder.symbol ? ` · ${reminder.symbol}` : ''}`]
  const url = reminder.symbol ? `/research/${encodeURIComponent(reminder.symbol)}` : '/portfolio'
  return build('reminder', `reminder:${reminder.id}`, subject, paragraphs, url, appUrl, reminder.symbol ? `open ${reminder.symbol}` : 'open ai·trader')
}

export interface FinishedRunSummary {
  runId: string
  symbol: string
  status: 'complete' | 'failed' | 'cancelled'
  error: string | null
  decision: { rating: string; confidence: number | null; rationale: string } | null
}

export function researchRunMessage(run: FinishedRunSummary, appUrl: string | null): NotificationMessage {
  const url = `/research/${encodeURIComponent(run.symbol)}?run=${encodeURIComponent(run.runId)}`
  const paragraphs: string[] = []
  let subject: string
  if (run.status === 'complete' && run.decision) {
    const conf = run.decision.confidence != null ? ` · confidence ${run.decision.confidence}` : ''
    subject = `${run.symbol} research done: ${run.decision.rating}${conf}`
    paragraphs.push(`The agents debate on ${run.symbol} finished with a ${run.decision.rating} rating${conf ? ` (confidence ${run.decision.confidence})` : ''}.`)
    const excerpt = clip(stripMarkdown(run.decision.rationale), 500)
    if (excerpt) paragraphs.push(excerpt)
  }
  else if (run.status === 'complete') {
    subject = `${run.symbol} research done`
    paragraphs.push(`The agents debate on ${run.symbol} finished without a recorded verdict.`)
  }
  else {
    subject = `${run.symbol} research ${run.status}`
    paragraphs.push(run.status === 'cancelled'
      ? `The agents debate on ${run.symbol} was cancelled.`
      : `The agents debate on ${run.symbol} failed${run.error ? `: ${clip(run.error, 300)}` : '.'}`)
  }
  return build('research_run', `run:${run.runId}`, subject, paragraphs, url, appUrl, 'open the run')
}

export interface FinishedChatReply {
  threadId: string
  messageId: string
  title: string | null
  /** The reply's answer text, as markdown. */
  text: string
  /** Why the reply ended early, when it did. */
  error: string | null
}

/** Push-only: the reply finished while nobody was looking at the chat. */
export function chatReplyMessage(reply: FinishedChatReply, appUrl: string | null): NotificationMessage {
  const subject = clip(reply.title?.trim() || 'ai·trader', 90)
  const body = reply.error
    ? clip(`Reply failed. ${reply.error}`, 140)
    : clip(stripMarkdown(reply.text), 140) || 'Reply ready'
  return build('chat_reply', `chat:${reply.messageId}`, subject, [body], `/?c=${encodeURIComponent(reply.threadId)}`, appUrl, 'open the chat')
}

/** Settings → "Send test …". A fresh dedupe key so every click sends. */
export function testMessage(appUrl: string | null): NotificationMessage {
  return build(
    'test',
    `test:${randomUUID()}`,
    'ai·trader test notification',
    ['Notifications are set up. Price alerts, reminders and finished research runs will arrive like this.'],
    '/settings',
    appUrl,
    'open settings',
  )
}

/**
 * Push payload the service worker shows: the subject and the first paragraph
 * of the text body. Never empty: iOS revokes subscriptions that push silently.
 */
export function pushPayload(m: Pick<NotificationMessage, 'subject' | 'bodyText' | 'url' | 'dedupeKey'>): { title: string; body: string; url: string; tag: string } {
  return {
    title: m.subject || 'ai·trader',
    body: clip((m.bodyText.split('\n\n')[0] ?? '').replace(/\s+/g, ' ').trim(), 180) || 'New notification',
    url: m.url ?? '/',
    tag: m.dedupeKey,
  }
}
