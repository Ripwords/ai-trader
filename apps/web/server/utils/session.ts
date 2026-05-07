import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SessionPayload {
  user: string
}

function b64url(buf: Buffer) {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function fromB64url(s: string) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

export function signSession(payload: SessionPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = b64url(createHmac('sha256', secret).update(body).digest())
  return `${body}.${sig}`
}

export function verifySession(token: string, secret: string): SessionPayload | null {
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = createHmac('sha256', secret).update(body).digest()
  const provided = fromB64url(sig)
  if (provided.length !== expected.length) return null
  if (!timingSafeEqual(provided, expected)) return null
  try {
    return JSON.parse(fromB64url(body).toString('utf8')) as SessionPayload
  } catch {
    return null
  }
}
