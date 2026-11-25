import { getApiClient } from '../../llm/http'
import { loadOpenOrders, type OpenOrders } from '../../lib/open-orders'
import { upstreamError } from '../../utils/upstream-error'

/**
 * Today's working orders on every tradable account, for the Orders page's
 * Active tab. An account whose orders could not be read is listed in
 * `failures` so the page can warn about it.
 */
export default defineEventHandler(async (): Promise<OpenOrders> => {
  try {
    return await loadOpenOrders(getApiClient())
  } catch (e) {
    throw upstreamError(e)
  }
})
