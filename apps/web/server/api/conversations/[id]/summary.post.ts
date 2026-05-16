import { getOwnerId, getThread, getThreadMessages } from '../../../db/repo'
import { buildConversationSummary } from '../../../lib/chat-management'
import { patchConversationMetadata } from '../../../lib/conversation-metadata'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const ownerId = await getOwnerId()
  const thread = await getThread(ownerId, id)
  if (!thread) throw createError({ statusCode: 404, statusMessage: 'not found' })

  const messages = await getThreadMessages(id)
  const result = buildConversationSummary(thread, messages)
  const metadata = await patchConversationMetadata(id, { summary: result.summary })
  return { metadata, summary: result.summary, decision: result.decision }
})
