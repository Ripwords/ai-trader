import { z } from 'zod'
import { createAlert } from '../../lib/alerts'
import { resolveSymbol } from '../../lib/yahoo'

const Body = z.object({
  symbol: z.string().min(1),
  kind: z.enum(['price_above', 'price_below', 'pct_move_day']),
  threshold: z.number().positive(),
  note: z.string().max(500).nullish(),
})

export default defineEventHandler(async (event) => {
  const body = Body.parse(await readBody(event))
  const resolution = await resolveSymbol(body.symbol)
  if (resolution.status !== 'resolved') {
    throw createError({
      statusCode: 400,
      statusMessage: `could not resolve symbol "${body.symbol}" (${resolution.status})`,
      data: resolution.status === 'ambiguous' ? { candidates: resolution.candidates } : undefined,
    })
  }
  const alert = await createAlert({
    symbol: resolution.symbol,
    kind: body.kind,
    threshold: body.threshold,
    note: body.note ?? null,
  })
  return { alert }
})
