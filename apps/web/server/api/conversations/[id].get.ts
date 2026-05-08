import { getOwnerId, getThread, getThreadMessages } from '../../db/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const ownerId = await getOwnerId()
  const thread = await getThread(ownerId, id)
  if (!thread) throw createError({ statusCode: 404, statusMessage: 'not found' })
  return { thread, messages: await getThreadMessages(id) }
})
