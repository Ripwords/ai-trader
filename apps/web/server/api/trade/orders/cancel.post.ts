import { z } from 'zod'
import { getApiClient } from '../../../llm/http'
import { trdEnvSchema } from '../../../lib/order-types'
import { upstreamError } from '../../../utils/upstream-error'

const bodySchema = z.object({
  order_id: z.string().min(1),
  acc_id: z.string().min(1),
  trd_env: trdEnvSchema,
})

/** Cancels one working order. The page asks for confirmation first. */
export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, bodySchema.parse)
  try {
    return await getApiClient().cancelOrder(body)
  } catch (e) {
    throw upstreamError(e)
  }
})
