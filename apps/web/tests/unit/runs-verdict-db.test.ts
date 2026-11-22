import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// Runs against a real, migrated Postgres. Point TEST_DATABASE_URL at a
// throwaway database.
const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('run verdict queries (TEST_DATABASE_URL)', () => {
  let q: typeof import('../../server/lib/agents/runs-query')
  let db: ReturnType<typeof import('../../db/client')['getDb']>
  let schema: typeof import('../../db/schema')
  let userId: string
  let strangerId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    q = await import('../../server/lib/agents/runs-query')
    db = (await import('../../db/client')).getDb()
    schema = await import('../../db/schema')
    const users = await db.insert(schema.users).values([{ name: 'verdict-test' }, { name: 'verdict-stranger' }])
      .returning({ id: schema.users.id })
    userId = users[0]!.id
    strangerId = users[1]!.id
  })

  afterEach(async () => {
    await db.delete(schema.valuationSnapshots)
    await db.delete(schema.agentRuns)
  })

  interface Seed {
    symbol?: string
    status?: string
    error?: string
    startedAt: string
    finishedAt?: string
    companyName?: string
    finalState?: Record<string, unknown>
    decision?: { rating: string; confidence: number | null; rationale: string }
    messages?: Array<Record<string, unknown> & { type: string }>
  }

  async function seedRun(seed: Seed): Promise<string> {
    const symbol = seed.symbol ?? 'US.AMZN'
    const [run] = await db.insert(schema.agentRuns).values({
      userId,
      symbol,
      tradeDate: seed.startedAt.slice(0, 10),
      config: seed.companyName ? { company_name: seed.companyName } : {},
      status: seed.status ?? 'complete',
      error: seed.error,
      startedAt: new Date(seed.startedAt),
      finishedAt: seed.finishedAt ? new Date(seed.finishedAt) : null,
      finalState: seed.finalState,
    }).returning({ id: schema.agentRuns.id })
    const runId = run!.id
    if (seed.decision) {
      await db.insert(schema.agentDecisions).values({ runId, userId, symbol, tradeDate: seed.startedAt.slice(0, 10), ...seed.decision })
    }
    if (seed.messages?.length) {
      await db.insert(schema.agentMessages).values(seed.messages.map((payload, seq) => ({ runId, seq, kind: payload.type, payload })))
    }
    return runId
  }

  const HOLD = { rating: 'hold', confidence: 33, rationale: 'Hold above $226.13.' }

  describe('getLatestRunForSymbol', () => {
    it('returns the latest complete run when a newer attempt failed', async () => {
      const complete = await seedRun({ startedAt: '2026-11-18T10:00:00Z', finishedAt: '2026-11-18T10:05:00Z', decision: HOLD })
      await seedRun({ startedAt: '2026-11-20T10:00:00Z', finishedAt: '2026-11-20T10:01:00Z', status: 'failed', error: 'agents service unreachable' })

      expect(await q.getLatestRunForSymbol(userId, 'US.AMZN')).toMatchObject({ runId: complete, status: 'complete', rating: 'hold' })
    })

    it('falls back to the latest finished run when none completed', async () => {
      const failed = await seedRun({ startedAt: '2026-11-20T10:00:00Z', status: 'failed', error: 'boom' })
      await seedRun({ startedAt: '2026-11-21T10:00:00Z', status: 'running' })

      expect(await q.getLatestRunForSymbol(userId, 'US.AMZN')).toMatchObject({ runId: failed, status: 'failed', rating: null })
    })

    it('finds a run stored under the market-prefixed symbol from the bare ticker, and the reverse', async () => {
      const prefixed = await seedRun({ startedAt: '2026-11-18T10:00:00Z', decision: HOLD })
      const bare = await seedRun({ symbol: 'NVDA', startedAt: '2026-11-18T10:00:00Z', decision: HOLD })

      expect((await q.getLatestRunForSymbol(userId, 'amzn'))?.runId).toBe(prefixed)
      expect((await q.getLatestRunForSymbol(userId, 'US.NVDA'))?.runId).toBe(bare)
      expect(await q.getLatestRunForSymbol(userId, 'HK.AMZN')).toBeNull()
      expect(await q.getLatestRunForSymbol(userId, 'MZN')).toBeNull()
    })

    it('carries the rating the agents reached before a valuation cap', async () => {
      await seedRun({
        startedAt: '2026-11-18T10:00:00Z', decision: HOLD,
        messages: [{ type: 'valuation-veto', original_rating: 'buy', effective_rating: 'hold', reason: 'price > 2x fair value', rating_cap: 'hold' }],
      })
      expect((await q.getLatestRunForSymbol(userId, 'AMZN'))?.originalRating).toBe('buy')
    })

    it('is scoped to the owner', async () => {
      await seedRun({ startedAt: '2026-11-18T10:00:00Z', decision: HOLD })
      expect(await q.getLatestRunForSymbol(strangerId, 'AMZN')).toBeNull()
    })
  })

  describe('getLatestAttemptForSymbol', () => {
    it('reports the newest run of any status', async () => {
      await seedRun({ startedAt: '2026-11-18T10:00:00Z', decision: HOLD })
      const failed = await seedRun({ startedAt: '2026-11-20T10:00:00Z', status: 'failed', error: 'agents service unreachable' })

      expect(await q.getLatestAttemptForSymbol(userId, 'AMZN')).toEqual({
        runId: failed, status: 'failed', error: 'agents service unreachable', startedAt: '2026-11-20T10:00:00.000Z',
      })
    })
  })

  describe('getRunVerdict', () => {
    const NOW = Date.parse('2026-11-22T12:00:00Z')

    it('assembles the verdict from the decision, the veto event, the valuation and the stored debate', async () => {
      const runId = await seedRun({
        startedAt: '2026-11-19T10:00:00Z', finishedAt: '2026-11-19T11:00:00Z', decision: HOLD,
        finalState: {
          market_report: 'x'.repeat(5000),
          investment_plan: 'The manager sided with the bear.',
          investment_debate_state: {
            bull_history: 'Bull Analyst: AWS grew 39.3%.',
            bear_history: 'Bear Analyst: Debt rose to $173.1B.',
            judge_decision: 'ignored',
          },
          risk_debate_state: {
            aggressive_history: 'Aggressive Analyst: Buy above 250.72.',
            conservative_history: 'Conservative Analyst: Interest expense tripled to $1.69B.',
            neutral_history: 'Neutral Analyst: Scale in.',
          },
        },
        messages: [
          { type: 'node-start', node: 'Market Analyst' },
          { type: 'valuation-veto', original_rating: 'buy', effective_rating: 'hold', reason: 'price > 2x fair value (margin of safety -55.0%)', rating_cap: 'hold' },
        ],
      })
      await db.insert(schema.valuationSnapshots).values({
        symbol: 'US.AMZN', source: 'agent_run', runId, fairValue: '108.000000', currentPrice: '240.350000',
        marginOfSafetyPct: '-0.550000', dataQuality: 'full', vetoTriggered: true, result: { currency: 'USD' },
      })

      expect(await q.getRunVerdict(userId, runId, NOW)).toMatchObject({
        runId, symbol: 'US.AMZN', status: 'complete', age_days: 3,
        rating: 'hold',
        rating_cap: { original_rating: 'buy', reason: 'price > 2x fair value (margin of safety -55.0%)' },
        confidence: 33,
        valuation: { status: 'valued', fair_value: 108, current_price: 240.35, margin_of_safety_pct: -55, data_quality: 'full', currency: 'USD' },
        bull_case: 'AWS grew 39.3%.',
        bear_case: 'Debt rose to $173.1B.',
        risk_dissent: [{ speaker: 'conservative', text: 'Interest expense tripled to $1.69B.' }],
        debate_note: null,
        rationale: 'Hold above $226.13.',
      })
    })

    it('reads a run stored before debates were captured', async () => {
      const runId = await seedRun({
        startedAt: '2026-10-31T10:00:00Z', finishedAt: '2026-10-31T11:00:00Z',
        decision: { ...HOLD, confidence: null },
        finalState: { investment_plan: 'The bear wins on free cash flow of -$46.9B.', final_trade_decision: 'Hold.' },
      })
      await db.insert(schema.valuationSnapshots).values({
        symbol: 'US.AMZN', source: 'agent_run', runId, fairValue: null, currentPrice: '240.350000',
        dataQuality: 'multiples_only', result: { currency: 'USD', dcf_invalid_reason: 'the base FCF conflicts with operating cash flow minus capex' },
      })

      const v = await q.getRunVerdict(userId, runId, NOW)
      expect(v).toMatchObject({
        rating: 'hold', rating_cap: null, confidence: null,
        valuation: { status: 'discarded', reason: 'the base FCF conflicts with operating cash flow minus capex', data_quality: 'multiples_only' },
        bull_case: null, bear_case: null, risk_dissent: null,
        research_manager_view: 'The bear wins on free cash flow of -$46.9B.',
      })
      expect(v).toHaveProperty('confidence_missing_reason', expect.stringMatching(/confidence judge/))
      expect(v).toHaveProperty('debate_note', expect.stringMatching(/not recorded/))
    })

    it('uses the reason the run recorded when it could not be valued', async () => {
      const runId = await seedRun({
        startedAt: '2026-11-19T10:00:00Z', decision: HOLD,
        messages: [{ type: 'valuation-unavailable', reason: 'fundamentals fetch timed out' }],
      })
      expect(await q.getRunVerdict(userId, runId, NOW)).toMatchObject({
        valuation: { status: 'unavailable', reason: 'fundamentals fetch timed out' },
      })
    })

    it('reports a failed run without a decision', async () => {
      const runId = await seedRun({ startedAt: '2026-11-20T10:00:00Z', status: 'failed', error: 'agents service unreachable' })
      expect(await q.getRunVerdict(userId, runId, NOW)).toMatchObject({
        status: 'failed', rating: null, no_verdict_reason: 'run failed: agents service unreachable',
      })
    })

    it('is null for a missing run and for another owner\'s run', async () => {
      const runId = await seedRun({ startedAt: '2026-11-19T10:00:00Z', decision: HOLD })
      expect(await q.getRunVerdict(strangerId, runId, NOW)).toBeNull()
      expect(await q.getRunVerdict(userId, '00000000-0000-4000-8000-000000000000', NOW)).toBeNull()
    })
  })

  describe('listResearchedSymbols', () => {
    it('lists each symbol the owner has finished runs for, once, with its company name', async () => {
      await seedRun({ startedAt: '2026-11-18T10:00:00Z', companyName: 'Amazon.com, Inc.', decision: HOLD })
      await seedRun({ startedAt: '2026-11-19T10:00:00Z', companyName: 'Amazon.com, Inc.', decision: HOLD })
      await seedRun({ symbol: 'US.NVDA', startedAt: '2026-11-19T10:00:00Z', decision: HOLD })
      await seedRun({ symbol: 'US.TSLA', startedAt: '2026-11-19T10:00:00Z', status: 'running' })

      const listed = await q.listResearchedSymbols(userId)
      expect(listed.sort((a, b) => a.symbol.localeCompare(b.symbol))).toEqual([
        { symbol: 'US.AMZN', companyName: 'Amazon.com, Inc.' },
        { symbol: 'US.NVDA', companyName: null },
      ])
      expect(await q.listResearchedSymbols(strangerId)).toEqual([])
    })
  })
})
