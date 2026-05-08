import { getAlgoApi } from '../../llm/http'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ code: string }>(event)
  return getAlgoApi().validateCode({ code: body.code })
})
