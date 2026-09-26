import { createError, defineEventHandler, readBody } from 'h3'
import { chatStreams } from '../../lib/chat-streams'
import { within } from '../../lib/within'

/**
 * POST /api/chat/stop  { requestId }
 *
 * Stops the reply to one send, named by the id the client gave it. Stop can be
 * pressed before the server has a thread for the send (a new chat) or before
 * the generation starts; the generation is then stopped as it starts. Answers
 * with the thread the send went to, so a new chat can open it.
 */
const SETTLE_MS = 5_000

export default defineEventHandler(async (event) => {
  const body = await readBody<{ requestId?: unknown }>(event)
  const requestId = body?.requestId
  if (typeof requestId !== 'string' || !requestId) {
    throw createError({ statusCode: 400, statusMessage: 'requestId is required' })
  }
  // A send that never reached the server leaves nothing to stop.
  const stopping = await within(chatStreams.stopRequest(requestId), SETTLE_MS, null)
  if (!stopping) return { stopped: false }
  await within<unknown>(stopping.done, SETTLE_MS, null)
  return { stopped: true, threadId: stopping.threadId }
})
