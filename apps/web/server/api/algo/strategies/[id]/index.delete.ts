import { getAlgoApi } from '../../../../llm/http'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  await getAlgoApi().deleteStrategy(id)
  return { ok: true }
})
