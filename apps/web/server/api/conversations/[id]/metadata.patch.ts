import { getOwnerId, getThread } from '../../../db/repo'
import { patchConversationMetadata } from '../../../lib/conversation-metadata'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const ownerId = await getOwnerId()
  const thread = await getThread(ownerId, id)
  if (!thread) throw createError({ statusCode: 404, statusMessage: 'not found' })

  const body = await readBody(event)
  return { metadata: await patchConversationMetadata(id, body ?? {}) }
})
