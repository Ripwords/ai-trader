import { z } from 'zod'
import { getApiClient } from '../../mastra/http'

const Body = z.object({ code: z.string(), group: z.string().default('All') })

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  return getApiClient().removeWatchlistItem(body)
})
