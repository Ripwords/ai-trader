import type { AlgoStrategyCreate } from '../../../llm/http'
import { getAlgoApi } from '../../../llm/http'

export default defineEventHandler(async (event) => {
  const body = await readBody<AlgoStrategyCreate>(event)
  return getAlgoApi().createStrategy(body)
})
