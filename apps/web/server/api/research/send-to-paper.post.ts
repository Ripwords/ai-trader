import { getApiClient } from '../../llm/http'
import type { PlaceOrderResult } from '../../llm/http'

const SIDE: Record<string, 'BUY' | 'SELL' | null> = {
  buy: 'BUY',
  sell: 'SELL',
  short: 'SELL',
  cover: 'BUY',
  hold: null,
}

export interface SendToPaperResponse {
  ok: true
  order: PlaceOrderResult
}

export default defineEventHandler(async (event): Promise<SendToPaperResponse> => {
  const body = await readBody<{ symbol?: string; action?: string; quantity?: number; acc_id?: string }>(event)
  const symbol = body?.symbol?.trim()
  const action = body?.action?.toLowerCase()
  const qty = Number(body?.quantity ?? 0)
  const acc_id = body?.acc_id?.trim() || undefined
  if (!symbol || !action) {
    throw createError({ statusCode: 400, statusMessage: 'symbol and action required' })
  }
  if (qty <= 0 || !Number.isInteger(qty)) {
    throw createError({ statusCode: 400, statusMessage: 'quantity must be a positive integer' })
  }
  const side = SIDE[action]
  if (!side) {
    throw createError({ statusCode: 400, statusMessage: `cannot send action='${action}' to paper (hold has no order)` })
  }
  const result = await getApiClient().placeOrder({
    code: symbol,
    side,
    qty,
    order_type: 'MARKET',
    trd_env: 'SIMULATE',
    acc_id,
  })
  return { ok: true, order: result }
})
