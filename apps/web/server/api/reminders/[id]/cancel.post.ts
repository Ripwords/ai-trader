import { cancelReminder } from '../../../lib/reminders'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const reminder = await cancelReminder(id)
  if (!reminder) {
    throw createError({ statusCode: 404, statusMessage: 'reminder not found or not scheduled' })
  }
  return { reminder }
})
