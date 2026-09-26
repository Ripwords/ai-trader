import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { providerUpdateSchema } from '../../../../../types/llm'
import { updateProvider } from '../../../../lib/llm-providers'
import { providerIdParam } from '../_params'

export default defineEventHandler(async (event) => {
  const id = await providerIdParam(event)
  const patch = await readValidatedBody(event, providerUpdateSchema.parse)
  const provider = await updateProvider(id, patch)
  if (!provider) throw createError({ statusCode: 404, statusMessage: 'Provider not found' })
  return { provider }
})
