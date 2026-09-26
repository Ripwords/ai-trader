import { defineEventHandler, getRouterParam } from 'h3'
import { getOwnerId, getThread } from '../../../db/repo'
import { chatSseResponse, chatStreams } from '../../../lib/chat-streams'

/**
 * GET /api/chat/:id/stream
 *
 * The AI SDK's resume endpoint (`useChat({ resume: true })`). While the
 * thread has a reply in progress, replays it from the start and follows it to
 * the end. 204 otherwise; the finished reply is already saved on the thread.
 */
export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, 'id') ?? ''
  const stream = (await getThread(await getOwnerId(), threadId)) ? chatStreams.subscribe(threadId) : null
  if (!stream) return new Response(null, { status: 204 })
  return chatSseResponse(stream)
})
