import { getAlgoApi } from '../../../../llm/http'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const body = await readBody<{ bars?: number }>(event).catch((): { bars?: number } => ({}))
  return getAlgoApi().backtest(id, { bars: body.bars ?? 200 })
})
