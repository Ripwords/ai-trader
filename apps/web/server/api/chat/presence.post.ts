import { createError, defineEventHandler, readRawBody } from 'h3'
import { chatPresence, chatPresenceSchema } from '../../lib/chat-presence'

/**
 * A tab says whether its chat is in view. Read raw because the pagehide
 * report comes from navigator.sendBeacon, which can only send text/plain.
 */
export default defineEventHandler(async (event) => {
  const raw = await readRawBody(event)
  let json: unknown
  try {
    json = JSON.parse(raw ?? '')
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'body must be JSON' })
  }
  const parsed = chatPresenceSchema.safeParse(json)
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'threadId, clientId and away required' })
  const { clientId, ...report } = parsed.data
  chatPresence.report(clientId, report, new Date())
  return { ok: true }
})
