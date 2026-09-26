import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SESSION_TTL_S, cookieSecure, signSession, verifySession } from '../../server/utils/session'

const SECRET = 'a'.repeat(32)
const NOW = Date.UTC(2026, 8, 1)

function forge(body: object): string {
  const b = Buffer.from(JSON.stringify(body)).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(b).digest('base64url')
  return `${b}.${sig}`
}

describe('session', () => {
  it('round-trips a valid token with issued-at and expiry', () => {
    const token = signSession({ user: 'owner' }, SECRET, NOW)
    expect(verifySession(token, SECRET, NOW)).toEqual({
      user: 'owner',
      iat: NOW / 1000,
      exp: NOW / 1000 + SESSION_TTL_S,
    })
  })

  it('lasts 30 days', () => {
    expect(SESSION_TTL_S).toBe(30 * 24 * 60 * 60)
    const token = signSession({ user: 'owner' }, SECRET, NOW)
    expect(verifySession(token, SECRET, NOW + (SESSION_TTL_S - 1) * 1000)).not.toBeNull()
  })

  it('rejects an expired token', () => {
    const token = signSession({ user: 'owner' }, SECRET, NOW)
    expect(verifySession(token, SECRET, NOW + SESSION_TTL_S * 1000)).toBeNull()
  })

  it('rejects a token issued in the future', () => {
    const token = signSession({ user: 'owner' }, SECRET, NOW + 10 * 60 * 1000)
    expect(verifySession(token, SECRET, NOW)).toBeNull()
  })

  it('rejects a correctly signed token without expiry, as issued before this change', () => {
    expect(verifySession(forge({ user: 'owner' }), SECRET, NOW)).toBeNull()
  })

  it('rejects a correctly signed token with a lifetime longer than the ttl', () => {
    const iat = NOW / 1000
    expect(verifySession(forge({ user: 'owner', iat, exp: iat + SESSION_TTL_S * 10 }), SECRET, NOW)).toBeNull()
  })

  it('rejects a tampered token', () => {
    const token = signSession({ user: 'owner' }, SECRET, NOW)
    const tampered = token.slice(0, -2) + 'aa'
    expect(verifySession(tampered, SECRET, NOW)).toBeNull()
  })

  it('rejects with wrong secret', () => {
    const token = signSession({ user: 'owner' }, SECRET, NOW)
    expect(verifySession(token, 'b'.repeat(32), NOW)).toBeNull()
  })
})

describe('cookieSecure', () => {
  it('follows the request protocol when not overridden', () => {
    expect(cookieSecure('', 'https')).toBe(true)
    expect(cookieSecure('', 'http')).toBe(false)
  })

  it('lets the env override win', () => {
    expect(cookieSecure('true', 'http')).toBe(true)
    expect(cookieSecure('false', 'https')).toBe(false)
  })
})
