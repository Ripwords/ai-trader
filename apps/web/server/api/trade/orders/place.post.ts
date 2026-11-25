import { getApiClient } from '../../../llm/http'
import { placeNow, ticketOrderSchema } from '../../../lib/order-proposals'
import { recordPaperOrder } from '../../../lib/paper-orders'

/**
 * The order ticket's "Place now". The page confirms a live order in a modal
 * that spells it out; the api's kill switch and daily cap still apply.
 */
export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, ticketOrderSchema.parse)
  return placeNow(body, getApiClient(), recordPaperOrder)
})
