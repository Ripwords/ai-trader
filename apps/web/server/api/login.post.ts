import { createError, defineEventHandler, getRequestIP, getRequestProtocol, readBody, setCookie, setResponseHeader } from 'h3'
import { z } from 'zod'
import { SESSION_TTL_S, cookieSecure, signSession } from '../utils/session'
import { createLoginLimiter } from '../utils/login-rate-limit'

const Body = z.object({ password: z.string() })

const limiter = createLoginLimiter({ max: 10, windowMs: 15 * 60 * 1000 })

export default defineEventHandler(async (event) => {
  const ip = getRequestIP(event) ?? 'unknown'
  const retryAfter = limiter.retryAfterS(ip)
  if (retryAfter !== null) {
    setResponseHeader(event, 'Retry-After', retryAfter)
    throw createError({ statusCode: 429, statusMessage: 'too many login attempts' })
  }
  const body = Body.parse(await readBody(event))
  const config = useRuntimeConfig()
  if (body.password !== config.appPassword) {
    limiter.fail(ip)
    throw createError({ statusCode: 401, statusMessage: 'invalid password' })
  }
  limiter.reset(ip)
  const token = signSession({ user: 'owner' }, config.sessionSecret)
  setCookie(event, 'session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(String(config.sessionCookieSecure ?? ''), getRequestProtocol(event, { xForwardedProto: true })),
    path: '/',
    maxAge: SESSION_TTL_S,
  })
  return { ok: true }
})
