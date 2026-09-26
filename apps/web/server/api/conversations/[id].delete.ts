import { deleteThread, getOwnerId } from '../../db/repo'
import { chatStreams } from '../../lib/chat-streams'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const ownerId = await getOwnerId()
  chatStreams.stop(id)
  await deleteThread(ownerId, id)
  return { ok: true }
})
