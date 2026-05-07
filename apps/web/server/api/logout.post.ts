export default defineEventHandler((event) => {
  setCookie(event, 'session', '', { maxAge: 0, path: '/' })
  return { ok: true }
})
