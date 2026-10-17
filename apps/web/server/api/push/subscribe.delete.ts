import { z } from 'zod'
import { deletePushSubscriptionByEndpoint } from '../../lib/push/subscriptions'

const Body = z.object({ endpoint: z.string().url() })

export default defineEventHandler(async (event) => {
  const { endpoint } = await readValidatedBody(event, Body.parse)
  return { removed: await deletePushSubscriptionByEndpoint(endpoint) }
})
