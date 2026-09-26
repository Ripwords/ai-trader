import { defineEventHandler, readValidatedBody } from 'h3'
import { providerCreateSchema } from '../../../../types/llm'
import { createProvider } from '../../../lib/llm-providers'

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, providerCreateSchema.parse)
  return { provider: await createProvider(input) }
})
