import { drizzleProposalStore, rejectProposal, parseProposalId } from '../../../../lib/order-proposals'

export default defineEventHandler(async (event) => {
  const id = parseProposalId(getRouterParam(event, 'id'))
  return rejectProposal(id, drizzleProposalStore())
})
