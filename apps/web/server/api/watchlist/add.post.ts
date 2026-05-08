import { z } from 'zod'
import { getApiClient } from '../../llm/http'

const Body = z.object({ code: z.string(), group: z.string().default('All') })

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  return getApiClient().addWatchlistItem(body)
})
