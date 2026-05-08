import type { AlgoStrategyUpdate } from '../../../../llm/http'
import { getAlgoApi } from '../../../../llm/http'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const body = await readBody<AlgoStrategyUpdate>(event)
  return getAlgoApi().updateStrategy(id, body)
})
