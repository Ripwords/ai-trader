import { createError, defineEventHandler } from 'h3'
import { deleteProvider } from '../../../../lib/llm-providers'
import { providerIdParam } from '../_params'

export default defineEventHandler(async (event) => {
  const outcome = await deleteProvider(await providerIdParam(event))
  if (outcome === 'not-found') throw createError({ statusCode: 404, statusMessage: 'Provider not found' })
  if (outcome === 'in-use') {
    throw createError({ statusCode: 409, statusMessage: 'This provider is selected for a model. Pick another model first.' })
  }
  return { ok: true }
})
