import webPush from 'web-push'

/** Web Push sender. Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT. */

export interface PushConfig {
  publicKey: string
  privateKey: string
  /** mailto: or https: contact the push services can reach. */
  subject: string
}

export function pushConfigFromEnv(env: Record<string, string | undefined> = process.env): PushConfig | null {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.VAPID_PRIVATE_KEY?.trim()
  const subject = env.VAPID_SUBJECT?.trim()
  if (!publicKey || !privateKey || !subject) return null
  return { publicKey, privateKey, subject }
}

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

export interface PushMessage {
  title: string
  body: string
  url: string
  tag: string
}

export type PushResult =
  | { result: 'sent' }
  /** The push service no longer knows this subscription; delete it. */
  | { result: 'gone' }
  | { result: 'error'; error: string }

const TTL_SECONDS = 24 * 60 * 60

export async function sendPush(cfg: PushConfig, target: PushTarget, message: PushMessage): Promise<PushResult> {
  try {
    await webPush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(message),
      { vapidDetails: cfg, TTL: TTL_SECONDS, urgency: 'high', timeout: 15_000 },
    )
    return { result: 'sent' }
  }
  catch (err: unknown) {
    const statusCode = (err as { statusCode?: number } | null)?.statusCode
    if (statusCode === 404 || statusCode === 410) return { result: 'gone' }
    const msg = err instanceof Error ? err.message : String(err)
    return { result: 'error', error: statusCode ? `push ${statusCode}: ${msg}` : `push: ${msg}` }
  }
}
