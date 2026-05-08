import { getAlgoApi } from '../../../../llm/http'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') as string
  return getAlgoApi().getStrategy(id)
})
