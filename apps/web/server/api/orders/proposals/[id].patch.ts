import { drizzleProposalStore, editProposal, proposalEditSchema, parseProposalId } from '../../../lib/order-proposals'

/** Edits the order fields of a pending proposal. */
export default defineEventHandler(async (event) => {
  const id = parseProposalId(getRouterParam(event, 'id'))
  const body = await readValidatedBody(event, proposalEditSchema.parse)
  return editProposal(id, body, drizzleProposalStore())
})
