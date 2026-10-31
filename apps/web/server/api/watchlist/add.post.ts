import { z } from 'zod'
import { getApiClient } from '../../llm/http'
import { upstreamError } from '../../utils/upstream-error'

const Body = z.object({ code: z.string(), group: z.string().default('All') })

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  try {
    return await getApiClient().addWatchlistItem(body)
  } catch (e) {
    throw upstreamError(e)
  }
})
