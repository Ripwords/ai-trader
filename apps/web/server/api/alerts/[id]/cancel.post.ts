import { cancelAlert } from '../../../lib/alerts'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const out = await cancelAlert(id)
  if ('error' in out) {
    throw createError({ statusCode: out.error === 'alert not found' ? 404 : 409, statusMessage: out.error })
  }
  return out
})
