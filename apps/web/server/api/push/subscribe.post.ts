import { pushSubscribeSchema, savePushSubscription } from '../../lib/push/subscriptions'

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, pushSubscribeSchema.parse)
  const id = await savePushSubscription({ ...body, userAgent: body.userAgent ?? getHeader(event, 'user-agent') ?? null })
  return { id }
})
