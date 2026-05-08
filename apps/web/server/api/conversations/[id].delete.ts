import { deleteThread, getOwnerId } from '../../db/repo'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'id required' })
  const ownerId = await getOwnerId()
  await deleteThread(ownerId, id)
  return { ok: true }
})
