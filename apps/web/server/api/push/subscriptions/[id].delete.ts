import { deletePushSubscriptionById } from '../../../lib/push/subscriptions'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  if (!(await deletePushSubscriptionById(id))) {
    throw createError({ statusCode: 404, statusMessage: 'device not found' })
  }
  return { removed: true }
})
