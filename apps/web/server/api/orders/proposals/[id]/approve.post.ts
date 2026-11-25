import { getApiClient } from '../../../../llm/http'
import { approveProposal, drizzleProposalStore, parseProposalId } from '../../../../lib/order-proposals'
import { recordPaperOrder } from '../../../../lib/paper-orders'

/**
 * Sends a pending proposal to the api, once (see approveProposal). The page
 * confirms a live proposal in a modal that spells the order out.
 */
export default defineEventHandler(async (event) => {
  const id = parseProposalId(getRouterParam(event, 'id'))
  return approveProposal(id, { store: drizzleProposalStore(), client: getApiClient(), recordPaper: recordPaperOrder })
})
