import { createProposal, drizzleProposalStore, proposalInputSchema } from '../../../lib/order-proposals'

const bodySchema = proposalInputSchema.omit({ source: true, decisionId: true, algoStrategyId: true })

/** The order ticket's "Add to queue". */
export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, bodySchema.parse)
  return createProposal({ ...body, source: 'ticket' }, drizzleProposalStore())
})
