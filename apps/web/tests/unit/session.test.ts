import { describe, expect, it } from 'vitest'
import { signSession, verifySession } from '../../server/utils/session'

const SECRET = 'a'.repeat(32)

describe('session', () => {
  it('round-trips a valid token', () => {
    const token = signSession({ user: 'owner' }, SECRET)
    expect(verifySession(token, SECRET)).toEqual({ user: 'owner' })
  })

  it('rejects a tampered token', () => {
    const token = signSession({ user: 'owner' }, SECRET)
    const tampered = token.slice(0, -2) + 'aa'
    expect(verifySession(tampered, SECRET)).toBeNull()
  })

  it('rejects with wrong secret', () => {
    const token = signSession({ user: 'owner' }, SECRET)
    expect(verifySession(token, 'b'.repeat(32))).toBeNull()
  })
})
