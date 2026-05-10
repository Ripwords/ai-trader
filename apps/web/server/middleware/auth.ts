import { verifySession } from '../utils/session'

const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/logout'])

export default defineEventHandler((event) => {
  const url = event.node.req.url ?? ''
  const path = url.split('?')[0] ?? ''
  if (PUBLIC_PATHS.has(path)) return
  // ``/internal/*`` is the api-side service surface (TradingAgents toolkit
  // calls back here for Yahoo/news data over docker DNS). It's gated by
  // INTERNAL_BEARER inside each route, NOT by session — the api container
  // has no session cookie. Skip the session check so the bearer guard
  // gets a chance to run.
  if (path.startsWith('/internal/')) return
  if (!path.startsWith('/api') && !['/'].includes(path) && !path.startsWith('/_')) {
    // static assets, devtools, etc — allow
    return
  }
  const token = getCookie(event, 'session')
  if (!token) {
    if (path.startsWith('/api')) {
      throw createError({ statusCode: 401, statusMessage: 'unauthenticated' })
    }
    return sendRedirect(event, '/login')
  }
  const sess = verifySession(token, useRuntimeConfig().sessionSecret)
  if (!sess) {
    if (path.startsWith('/api')) {
      throw createError({ statusCode: 401, statusMessage: 'invalid session' })
    }
    return sendRedirect(event, '/login')
  }
  event.context.session = sess
})
