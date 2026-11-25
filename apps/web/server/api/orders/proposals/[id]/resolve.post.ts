import { z } from 'zod'
import { getApiClient } from '../../../../llm/http'
import { drizzleProposalStore, parseProposalId, resolveSubmitting } from '../../../../lib/order-proposals'

const bodySchema = z.object({ force: z.boolean().optional() }).strict()

/**
 * Unsticks a proposal left in submitting: checks moomoo for its order and
 * settles it (see resolveSubmitting). `force` marks it failed when moomoo
 * can't be checked; the page asks before sending it.
 */
export default defineEventHandler(async (event) => {
  const id = parseProposalId(getRouterParam(event, 'id'))
  const parsed = bodySchema.safeParse((await readBody(event).catch(() => null)) ?? {})
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: 'body must be { force?: boolean }' })
  return resolveSubmitting(id, { store: drizzleProposalStore(), client: getApiClient(), force: parsed.data.force })
})
