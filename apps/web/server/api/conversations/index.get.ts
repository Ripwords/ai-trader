import { getOwnerId, listThreads } from '../../db/repo'
import { applyConversationMetadata } from '../../lib/chat-management'
import { getConversationMetadataMap } from '../../lib/conversation-metadata'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const includeArchived = query.archived === '1' || query.archived === 'true'
  const ownerId = await getOwnerId()
  const [threads, metadata] = await Promise.all([
    listThreads(ownerId),
    getConversationMetadataMap(),
  ])
  return { conversations: applyConversationMetadata(threads, metadata, { includeArchived }) }
})
