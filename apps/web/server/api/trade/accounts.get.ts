import { getApiClient } from '../../llm/http'
import { summarizeAccount, tradableAccounts, type AccountSummary } from '../../lib/open-orders'
import { upstreamError } from '../../utils/upstream-error'

/** The accounts the Orders page can trade (IPO accounts left out). */
export default defineEventHandler(async (): Promise<AccountSummary[]> => {
  try {
    return tradableAccounts(await getApiClient().listAccounts()).map(summarizeAccount)
  } catch (e) {
    throw upstreamError(e)
  }
})
