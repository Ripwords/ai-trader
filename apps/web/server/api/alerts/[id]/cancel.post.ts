import { cancelAlert } from '../../../lib/alerts'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const alert = await cancelAlert(id)
  if (!alert) {
    throw createError({ statusCode: 404, statusMessage: 'alert not found or not active' })
  }
  return { alert }
})
