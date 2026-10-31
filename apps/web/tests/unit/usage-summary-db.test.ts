import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// Runs against a real, migrated Postgres. Point TEST_DATABASE_URL at a
// throwaway database.
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('usage summary (TEST_DATABASE_URL)', () => {
  let repo: typeof import('../../server/db/repo')
  let db: ReturnType<typeof import('../../db/client')['getDb']>
  let schema: typeof import('../../db/schema')
  let userId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    repo = await import('../../server/db/repo')
    db = (await import('../../db/client')).getDb()
    schema = await import('../../db/schema')
    const [u] = await db.insert(schema.users).values({ name: 'usage-summary-test' }).returning({ id: schema.users.id })
    userId = u!.id
  })

  afterEach(async () => {
    await db.delete(schema.llmUsage)
    await db.delete(schema.agentRuns)
  })

  const call = (over: Partial<typeof schema.llmUsage.$inferInsert> = {}) => ({
    userId, source: 'chat', modelSpec: 'deepseek/deepseek-v4-pro', inputTokens: 100, outputTokens: 10, totalTokens: 110, estimatedCostUsd: '0.010000', ...over,
  })

  it('counts finished agents debates, which the api never writes to llm_usage', async () => {
    await db.insert(schema.llmUsage).values(call())
    await db.insert(schema.agentRuns).values([
      { userId, symbol: 'US.AMZN', tradeDate: '2026-10-31', config: {}, status: 'complete', tokensIn: 50_000, tokensOut: 5_000, costUsd: '0.4000' },
      // Still running: its cost is not known yet.
      { userId, symbol: 'US.NVDA', tradeDate: '2026-10-31', config: {}, status: 'running' },
    ])
    const s = await repo.getLlmUsageSummary(userId, 'UTC')
    expect(s.totals.month).toMatchObject({ calls: 2, totalTokens: 55_110, estimatedCostUsd: 0.41, unpricedCalls: 0 })
    expect(s.bySource.map(r => [r.source, r.calls, r.estimatedCostUsd])).toEqual([['agents-debate', 1, 0.4], ['chat', 1, 0.01]])
  })

  it('says how many calls had no price instead of folding them into the total as $0', async () => {
    await db.insert(schema.llmUsage).values([call(), call({ modelSpec: 'openrouter/some-model', estimatedCostUsd: null })])
    const s = await repo.getLlmUsageSummary(userId, 'UTC')
    expect(s.totals.today).toMatchObject({ calls: 2, estimatedCostUsd: 0.01, unpricedCalls: 1 })
    expect(s.bySource[0]).toMatchObject({ source: 'chat', unpricedCalls: 1 })
  })

  it('starts "today" at midnight in the given time zone', async () => {
    // 23:30 yesterday in Kuala Lumpur (UTC+8) and 00:30 today.
    const now = new Date()
    const klMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 8 * 3600_000)
    const today = now.getTime() >= klMidnight.getTime() + 24 * 3600_000 ? new Date(klMidnight.getTime() + 24 * 3600_000) : klMidnight
    await db.insert(schema.llmUsage).values([
      call({ ts: new Date(today.getTime() - 30 * 60_000) }),
      call({ ts: new Date(Math.min(today.getTime() + 30 * 60_000, now.getTime())) }),
    ])
    const s = await repo.getLlmUsageSummary(userId, 'Asia/Kuala_Lumpur')
    expect(s.totals.today.calls).toBe(1)
  })

  it('sums past the 32-bit integer range without failing', async () => {
    await db.insert(schema.llmUsage).values([call({ totalTokens: 2_000_000_000 }), call({ totalTokens: 2_000_000_000 })])
    const s = await repo.getLlmUsageSummary(userId, 'UTC')
    expect(s.totals.allTime.totalTokens).toBe(4_000_000_000)
  })
})
