import { getAlgoApi } from '../../llm/http'

export default defineEventHandler((event) => {
  const q = getQuery(event)
  return getAlgoApi().listSignals({
    strategy_id: typeof q.strategy_id === 'string' ? q.strategy_id : undefined,
    limit: typeof q.limit === 'string' ? Number(q.limit) : undefined,
  })
})
