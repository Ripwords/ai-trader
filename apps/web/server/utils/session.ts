import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_TTL_S = 30 * 24 * 60 * 60
const CLOCK_SKEW_S = 60

export interface SessionPayload {
  user: string
  /** Issued-at, unix seconds. */
  iat: number
  /** Expiry, unix seconds. */
  exp: number
}

function b64url(buf: Buffer) {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function fromB64url(s: string) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

export function signSession(payload: { user: string }, secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000)
  const full: SessionPayload = { user: payload.user, iat, exp: iat + SESSION_TTL_S }
  const body = b64url(Buffer.from(JSON.stringify(full)))
  const sig = b64url(createHmac('sha256', secret).update(body).digest())
  return `${body}.${sig}`
}

function parsePayload(raw: unknown): SessionPayload | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { user, iat, exp } = raw as Record<string, unknown>
  if (typeof user !== 'string' || typeof iat !== 'number' || typeof exp !== 'number') return null
  return { user, iat, exp }
}

export function verifySession(token: string, secret: string, now = Date.now()): SessionPayload | null {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', secret).update(body).digest()
  const provided = fromB64url(sig)
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null
  let payload: SessionPayload | null
  try {
    payload = parsePayload(JSON.parse(fromB64url(body).toString('utf8')))
  } catch {
    return null
  }
  if (!payload) return null
  const nowS = now / 1000
  if (payload.iat > nowS + CLOCK_SKEW_S) return null
  if (payload.exp <= nowS) return null
  if (payload.exp - payload.iat > SESSION_TTL_S) return null
  return payload
}

/** `override` is NUXT_SESSION_COOKIE_SECURE: 'true' or 'false' wins, anything else follows the protocol. */
export function cookieSecure(override: string, protocol: string): boolean {
  if (override === 'true') return true
  if (override === 'false') return false
  return protocol === 'https'
}
