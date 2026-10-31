import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// Runs against a real, migrated Postgres. Point TEST_DATABASE_URL at a
// throwaway database.
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('agent run usage (TEST_DATABASE_URL)', () => {
  let tee: typeof import('../../server/utils/agents-tee')
  let db: ReturnType<typeof import('../../db/client')['getDb']>
  let schema: typeof import('../../db/schema')
  let userId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    tee = await import('../../server/utils/agents-tee')
    db = (await import('../../db/client')).getDb()
    schema = await import('../../db/schema')
    const [u] = await db.insert(schema.users).values({ name: 'usage-test' }).returning({ id: schema.users.id })
    userId = u!.id
  })

  afterEach(async () => {
    await db.delete(schema.agentRuns)
  })

  it('adds a resumed run\'s tokens and cost to what the first attempt spent, so the daily cap and /usage see both', async () => {
    const [run] = await db.insert(schema.agentRuns)
      .values({ userId, symbol: 'US.NVDA', tradeDate: '2026-10-31', config: {}, status: 'running' })
      .returning({ id: schema.agentRuns.id })
    await tee.addRunUsage(run!.id, { tokens_in: 1000, tokens_out: 200, cost_usd: 0.12 })
    await tee.addRunUsage(run!.id, { tokens_in: 500, tokens_out: 100, cost_usd: 0.05 })

    const [row] = await db.select().from(schema.agentRuns)
    expect(row).toMatchObject({ tokensIn: 1500, tokensOut: 300, costUsd: '0.1700' })
  })
})
