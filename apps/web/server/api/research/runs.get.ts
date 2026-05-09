import { getOwnerId, listWorkflowRuns, type WorkflowRunRow } from '../../db/repo'

export default defineEventHandler(async (event): Promise<{ runs: WorkflowRunRow[] }> => {
  const q = getQuery(event)
  const symbol = typeof q.symbol === 'string' ? q.symbol : undefined
  const limit = typeof q.limit === 'string' ? Number(q.limit) : 50

  const ownerId = await getOwnerId()
  const runs = await listWorkflowRuns(ownerId, {
    workflowId: 'analyze-ticker',
    symbol,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
  })
  return { runs }
})
