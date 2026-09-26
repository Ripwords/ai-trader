import { getValidatedRouterParams, type H3Event } from 'h3'
import { z } from 'zod'

const params = z.object({ id: z.string().uuid() })

export async function providerIdParam(event: H3Event): Promise<string> {
  return (await getValidatedRouterParams(event, params.parse)).id
}
