import { getOwnerId, getThread, getThreadMessages } from '../../../db/repo'
import { buildConversationSummary } from '../../../lib/chat-management'
import { recordConversationDecision } from '../../../lib/conversation-metadata'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const ownerId = await getOwnerId()
  const thread = await getThread(ownerId, id)
  if (!thread) throw createError({ statusCode: 404, statusMessage: 'not found' })

  const body = await readBody(event)
  const messages = await getThreadMessages(id)
  const summary = buildConversationSummary(thread, messages)
  const title = typeof body?.title === 'string' && body.title.trim()
    ? body.title.trim()
    : summary.decision?.title ?? thread.title
  const note = typeof body?.note === 'string' && body.note.trim()
    ? body.note.trim()
    : summary.summary

  return { metadata: await recordConversationDecision(id, { title, note }) }
})
