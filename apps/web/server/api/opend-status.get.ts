import { getApiClient } from '../mastra/http'

export default defineEventHandler(async () => {
  try {
    return await getApiClient().getOpendState()
  } catch {
    // FastAPI itself unreachable; treat as fully down.
    return { reachable: false, qot_logined: false, trd_logined: false }
  }
})
