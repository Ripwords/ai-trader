import { z } from 'zod'
import { signSession } from '../utils/session'

const Body = z.object({ password: z.string() })

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  const config = useRuntimeConfig()
  if (body.password !== config.appPassword) {
    throw createError({ statusCode: 401, statusMessage: 'invalid password' })
  }
  const token = signSession({ user: 'owner' }, config.sessionSecret)
  setCookie(event, 'session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
  return { ok: true }
})
