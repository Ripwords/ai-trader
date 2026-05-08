import { getOwnerId, listThreads } from '../../db/repo'

export default defineEventHandler(async () => {
  const ownerId = await getOwnerId()
  return { conversations: await listThreads(ownerId) }
})
