import { analyzeTickerWorkflow } from '../../mastra'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ symbol?: string; analysts?: string[]; personas?: string[] }>(event)
  const symbol = body?.symbol?.trim()
  if (!symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }
  const run = await analyzeTickerWorkflow.createRun()
  const result = await run.start({
    inputData: {
      symbol,
      analysts: (body.analysts as ('fundamentals' | 'valuation' | 'technicals' | 'sentiment')[] | undefined)
        ?? ['fundamentals', 'valuation', 'technicals', 'sentiment'],
      personas: (body.personas as ('buffett' | 'munger' | 'burry' | 'druckenmiller' | 'wood')[] | undefined)
        ?? ['buffett', 'munger', 'burry', 'druckenmiller', 'wood'],
    },
  })
  if (result.status !== 'success') {
    throw createError({ statusCode: 500, statusMessage: `workflow status=${result.status}` })
  }
  return result.result
})
