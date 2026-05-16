import { getOwnerId, getThreadMessages, listThreads } from '../../db/repo'
import { applyConversationMetadata, searchConversationThreads } from '../../lib/chat-management'
import { getConversationMetadataMap } from '../../lib/conversation-metadata'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const q = typeof query.q === 'string' ? query.q.trim() : ''
  if (q.length < 2) return { results: [] }

  const includeArchived = query.archived === '1' || query.archived === 'true'
  const ownerId = await getOwnerId()
  const [threads, metadata] = await Promise.all([
    listThreads(ownerId),
    getConversationMetadataMap(),
  ])
  const managed = applyConversationMetadata(threads, metadata, { includeArchived })
  const messagesByThread: Record<string, unknown[]> = {}
  await Promise.all(managed.map(async (thread) => {
    messagesByThread[thread.id] = await getThreadMessages(thread.id)
  }))

  return { results: searchConversationThreads(managed, messagesByThread, q).slice(0, 20) }
})
