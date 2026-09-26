import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { providerTestSchema, type ProviderTestResult } from '../../../../../../types/llm'
import { testProviderConnection } from '../../../../../lib/llm-provider-probe'
import { getProviderConnection } from '../../../../../lib/llm-providers'
import { providerIdParam } from '../../_params'

export default defineEventHandler(async (event): Promise<ProviderTestResult> => {
  const id = await providerIdParam(event)
  const { modelId } = await readValidatedBody(event, body => providerTestSchema.parse(body ?? {}))
  const conn = await getProviderConnection(id)
  if (!conn) throw createError({ statusCode: 404, statusMessage: 'Provider not found' })
  return testProviderConnection(conn, modelId)
})
