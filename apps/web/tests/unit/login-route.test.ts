import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLoginLimiter } from '../../server/utils/login-rate-limit'
import { verifySession } from '../../server/utils/session'

const SECRET = 's'.repeat(32)

interface FakeEvent {
  _body: unknown
  _ip: string
  _protocol: string
  cookies: Record<string, { value: string, opts: Record<string, unknown> }>
  headers: Record<string, string>
}

vi.mock('h3', async () => {
  const actual = await vi.importActual<typeof import('h3')>('h3')
  return {
    ...actual,
    readBody: vi.fn(async (e: FakeEvent) => e._body),
    getRequestIP: vi.fn((e: FakeEvent) => e._ip),
    getRequestProtocol: vi.fn((e: FakeEvent) => e._protocol),
    setCookie: vi.fn((e: FakeEvent, name: string, value: string, opts: Record<string, unknown>) => {
      e.cookies[name] = { value, opts }
    }),
    setResponseHeader: vi.fn((e: FakeEvent, name: string, value: string) => {
      e.headers[name] = value
    }),
  }
})

function event(password: string, ip = '10.0.0.1', protocol = 'http'): FakeEvent {
  return { _body: { password }, _ip: ip, _protocol: protocol, cookies: {}, headers: {} }
}

type Handler = (e: H3Event) => Promise<{ ok: true }>
let handler: Handler
let cookieSecureEnv = ''

beforeEach(async () => {
  vi.resetModules()
  cookieSecureEnv = ''
  vi.stubGlobal('useRuntimeConfig', () => ({
    appPassword: 'pw',
    sessionSecret: SECRET,
    sessionCookieSecure: cookieSecureEnv,
  }))
  handler = (await import('../../server/api/login.post')).default as unknown as Handler
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const call = (e: FakeEvent) => handler(e as unknown as H3Event)

describe('POST /api/login', () => {
  it('sets a 30-day session cookie that verifies', async () => {
    const e = event('pw')
    await expect(call(e)).resolves.toEqual({ ok: true })
    const cookie = e.cookies.session!
    expect(cookie.opts.maxAge).toBe(30 * 24 * 60 * 60)
    expect(verifySession(cookie.value, SECRET)).toMatchObject({ user: 'owner' })
  })

  it('marks the cookie secure over https only', async () => {
    const plain = event('pw')
    await call(plain)
    expect(plain.cookies.session!.opts.secure).toBe(false)
    const tls = event('pw', '10.0.0.1', 'https')
    await call(tls)
    expect(tls.cookies.session!.opts.secure).toBe(true)
  })

  it('rejects a wrong password with 401', async () => {
    await expect(call(event('nope'))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('returns 429 after 10 failed attempts from one IP, even with the right password', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(call(event('nope'))).rejects.toMatchObject({ statusCode: 401 })
    }
    const e = event('pw')
    await expect(call(e)).rejects.toMatchObject({ statusCode: 429 })
    expect(Number(e.headers['Retry-After'])).toBeGreaterThan(0)
    await expect(call(event('pw', '10.0.0.2'))).resolves.toEqual({ ok: true })
  })

  it('clears the failure count on a successful login', async () => {
    for (let i = 0; i < 9; i++) await call(event('nope')).catch(() => undefined)
    await call(event('pw'))
    for (let i = 0; i < 9; i++) await call(event('nope')).catch(() => undefined)
    await expect(call(event('pw'))).resolves.toEqual({ ok: true })
  })
})

describe('createLoginLimiter', () => {
  it('blocks after max failures and unblocks when the window passes', () => {
    const lim = createLoginLimiter({ max: 3, windowMs: 1_000 })
    for (let i = 0; i < 3; i++) lim.fail('ip', 0)
    expect(lim.retryAfterS('ip', 500)).toBe(1)
    expect(lim.retryAfterS('ip', 1_000)).toBeNull()
  })

  it('drops expired entries so memory stays bounded', () => {
    const lim = createLoginLimiter({ max: 3, windowMs: 1_000 })
    for (let i = 0; i < 100; i++) lim.fail(`ip${i}`, 0)
    lim.fail('late', 2_000)
    expect(lim.size()).toBe(1)
  })
})
