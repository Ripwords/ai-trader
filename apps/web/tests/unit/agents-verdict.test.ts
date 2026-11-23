import { describe, it, expect } from 'vitest'
import { buildRunVerdict, type PersistedRun } from '../../server/lib/agents/verdict'

const NOW = Date.parse('2026-11-22T12:00:00Z')

const filler = (label: string, sentences: number) =>
  Array.from({ length: sentences }, (_, i) => `${label} keeps arguing the same qualitative point in round ${'i'.repeat(i + 1)}.`)
    .join(' ')
    .replaceAll(/\d/g, '')

const LONG_RATIONALE = [
  'My ruling is **HOLD**. The business is improving but the stock is below the levels that justify new buying.',
  '',
  '## Why not BUY',
  filler('The judge', 30),
  '- No new capital below 250.72.',
  '',
  '## Exit',
  '- Hard exit below 226.13 regardless of volume.',
  filler('The desk', 30),
  '',
  'FINAL TRANSACTION PROPOSAL: **HOLD**',
].join('\n')

function run(over: Partial<PersistedRun> = {}): PersistedRun {
  return {
    runId: 'run-1',
    symbol: 'US.AMZN',
    status: 'complete',
    error: null,
    finishedAt: new Date('2026-11-19T11:00:00Z'),
    decision: { rating: 'hold', confidence: 33, rationale: LONG_RATIONALE, ownerVerdict: null },
    cap: null,
    valuation: {
      fairValue: 301.5, currentPrice: 240.35, marginOfSafetyPct: 0.2028, dataQuality: 'full',
      currency: 'USD', discardedReason: null, warning: null, multiples: null, historicalMultiples: null,
    },
    valuationEvent: null,
    debate: {
      bull: `Bull Analyst: ${filler('The bull', 12)} AWS grew 39.3% on a $184B run rate. ${filler('The bull', 12)}`,
      bear: `Bear Analyst: ${filler('The bear', 12)} Long-term debt rose from $65.6B to $173.1B. ${filler('The bear', 12)}`,
      aggressive: `Aggressive Analyst: ${filler('The aggressive analyst', 10)} Pounce above 250.72.`,
      conservative: `Conservative Analyst: ${filler('The conservative analyst', 10)} Interest expense tripled to $1.69B.`,
      neutral: `Neutral Analyst: ${filler('The neutral analyst', 10)} Scale in at 45% odds.`,
      researchManager: `I side with the bear. ${filler('The manager', 20)} Free cash flow is -$46.9B.`,
    },
    ...over,
  }
}

function verdictOf(over: Partial<PersistedRun> = {}) {
  const v = buildRunVerdict(run(over), NOW)
  if (v.rating === null) throw new Error('expected a verdict')
  return v
}

describe('buildRunVerdict', () => {
  it('identifies the run, its age and where the full text lives', () => {
    expect(verdictOf()).toMatchObject({
      runId: 'run-1',
      symbol: 'US.AMZN',
      status: 'complete',
      finishedAt: '2026-11-19T11:00:00.000Z',
      age_days: 3,
      run_url: '/research/US.AMZN?run=run-1',
      rating: 'hold',
    })
  })

  it('has no events and no unbounded field', () => {
    const v = verdictOf()
    expect(v).not.toHaveProperty('events')
    expect(JSON.stringify(v).length).toBeLessThan(4500)
  })

  describe('rating cap', () => {
    it('is null when the valuation did not change the rating', () => {
      expect(verdictOf().rating_cap).toBeNull()
    })

    it('names the rating the agents reached and why it was capped', () => {
      const v = verdictOf({ cap: { originalRating: 'buy', reason: 'price > 2x fair value (margin of safety -55.0%)' } })
      expect(v.rating).toBe('hold')
      expect(v.rating_cap).toEqual({ original_rating: 'buy', reason: 'price > 2x fair value (margin of safety -55.0%)' })
    })
  })

  describe('confidence', () => {
    it('states what the number measures for the rating it scores', () => {
      const hold = verdictOf()
      expect(hold.confidence).toBe(33)
      expect(hold.confidence_missing_reason).toBeNull()
      expect(hold.confidence_measures).toContain('7 trading days')
      expect(hold.confidence_measures).toContain('within 1 percentage point of SPY')

      const buy = verdictOf({ decision: { rating: 'buy', confidence: 61, rationale: 'Buy above $240.' } })
      expect(buy.confidence_measures).toContain('beats SPY by more than 0.5 percentage points')
      const sell = verdictOf({ decision: { rating: 'sell', confidence: 61, rationale: 'Sell below $240.' } })
      expect(sell.confidence_measures).toContain('trails SPY by more than 0.5 percentage points')
    })

    it('says why it is missing', () => {
      const v = verdictOf({ decision: { rating: 'buy', confidence: null, rationale: 'Buy above $240.' } })
      expect(v.confidence).toBeNull()
      expect(v.confidence_missing_reason).toMatch(/confidence judge/)
    })
  })

  describe('valuation', () => {
    it('summarises a DCF fair value with margin of safety in percent', () => {
      expect(verdictOf().valuation).toEqual({
        status: 'valued', fair_value: 301.5, current_price: 240.35, margin_of_safety_pct: 20.3,
        data_quality: 'full', currency: 'USD',
      })
    })

    it('says why a discarded DCF has no fair value', () => {
      const v = verdictOf({
        valuation: {
          fairValue: null, currentPrice: 240.35, marginOfSafetyPct: null, dataQuality: 'multiples_only',
          currency: 'USD', discardedReason: 'the base FCF (3.22B) conflicts with operating cash flow minus capex of -46.89B',
          warning: 'DCF out of regime and discarded', multiples: { pe: 19.430073, pb: 6.274474, ps: 3.3498654, p_fcf: 807.1832449 },
          historicalMultiples: null,
        },
      })
      expect(v.valuation).toEqual({
        status: 'discarded',
        reason: 'the base FCF (3.22B) conflicts with operating cash flow minus capex of -46.89B',
        current_price: 240.35, data_quality: 'multiples_only', currency: 'USD',
        multiples: { pe: 19.43, pb: 6.27, ps: 3.35, p_fcf: 807.18 },
      })
    })

    // Run f266c5eb (US.AMZN, 2026-11-22): the DCF was skipped on negative free
    // cash flow, and the chat was told no valuation existed.
    const SKIPPED = 'DCF skipped: non-positive FCF or missing shares; multiples-only (no fabricated fair value)'
    const multiplesOnly = {
      fairValue: null, currentPrice: 246.820007, marginOfSafetyPct: null, dataQuality: 'multiples_only',
      currency: 'USD', discardedReason: null, warning: SKIPPED,
      multiples: { pe: 19.953114, pb: 4.348715, ps: 3.3467703, p_fcf: null },
      historicalMultiples: { pe: 31.82103412815517, pb: null, ps: 3.447422210351184, p_fcf: null },
    }

    it('reports a skipped DCF as multiples only, with the run\'s reason and the multiples', () => {
      const v = verdictOf({ valuation: multiplesOnly, valuationEvent: { status: 'multiples_only', reason: SKIPPED } })
      expect(v.valuation).toEqual({
        status: 'multiples_only',
        reason: SKIPPED,
        current_price: 246.82,
        currency: 'USD',
        multiples: { pe: 19.95, pb: 4.35, ps: 3.35 },
        historical_multiples: { pe: 31.82, ps: 3.45 },
      })
    })

    it('falls back to the snapshot\'s own warning when the run recorded no valuation event', () => {
      expect(verdictOf({ valuation: multiplesOnly }).valuation).toMatchObject({ status: 'multiples_only', reason: SKIPPED })
      expect(verdictOf({ valuation: { ...multiplesOnly, warning: null } }).valuation)
        .toMatchObject({ status: 'multiples_only', reason: 'no DCF fair value was computed; only the multiples are available' })
    })

    it('leaves out multiples the snapshot does not hold', () => {
      const v = verdictOf({ valuation: { ...multiplesOnly, multiples: null, historicalMultiples: { pe: null, pb: null, ps: null, p_fcf: null } } })
      expect(v.valuation).not.toHaveProperty('multiples')
      expect(v.valuation).not.toHaveProperty('historical_multiples')
    })

    it('uses the recorded reason when no valuation was stored', () => {
      expect(verdictOf({ valuation: null, valuationEvent: { status: 'unavailable', reason: 'fundamentals fetch timed out' } }).valuation)
        .toEqual({ status: 'unavailable', reason: 'fundamentals fetch timed out' })
      expect(verdictOf({ valuation: null }).valuation)
        .toEqual({ status: 'unavailable', reason: 'no valuation was recorded for this run' })
    })
  })

  describe('debate', () => {
    it('bounds the bull and bear cases and keeps their figures', () => {
      const v = verdictOf()
      expect(v.bull_case!.length).toBeLessThanOrEqual(450)
      expect(v.bear_case!.length).toBeLessThanOrEqual(450)
      expect(v.bull_case).toContain('AWS grew 39.3% on a $184B run rate.')
      expect(v.bear_case).toContain('Long-term debt rose from $65.6B to $173.1B.')
      expect(v.bull_case).not.toContain('Bull Analyst:')
      expect(v.debate_note).toBeNull()
      expect(v).not.toHaveProperty('research_manager_view')
    })

    it('takes the dissent from the voices that argued against the rating', () => {
      const dissent = (rating: string) =>
        verdictOf({ decision: { rating, confidence: 50, rationale: 'x' } }).risk_dissent!.map(d => d.speaker)
      expect(dissent('buy')).toEqual(['conservative'])
      expect(dissent('strong-buy')).toEqual(['conservative'])
      expect(dissent('sell')).toEqual(['aggressive'])
      expect(dissent('reduce')).toEqual(['aggressive'])
      expect(dissent('hold')).toEqual(['aggressive', 'conservative'])
    })

    it('judges dissent against the rating the risk debate produced, not the capped one', () => {
      const v = verdictOf({ cap: { originalRating: 'buy', reason: 'cap' } })
      expect(v.risk_dissent!.map(d => d.speaker)).toEqual(['conservative'])
    })

    it('bounds the dissent and keeps its figures', () => {
      const v = verdictOf()
      expect(v.risk_dissent).toEqual([
        { speaker: 'aggressive', text: expect.stringContaining('Pounce above 250.72.') },
        { speaker: 'conservative', text: expect.stringContaining('Interest expense tripled to $1.69B.') },
      ])
      expect(JSON.stringify(v.risk_dissent).length).toBeLessThanOrEqual(700)
    })

    it('says so when the arguments carry no figures and returns their opening instead', () => {
      const bull = `Bull Analyst: ${filler('The bull', 30)}`
      const v = verdictOf({ debate: { ...run().debate, bull } })
      expect(v.bull_case!.length).toBeLessThanOrEqual(450)
      expect(bull).toContain(v.bull_case!)
      expect(v.debate_note).toMatch(/bull_case.*opening/)
    })

    it('explains a run stored before debates were captured and falls back to the research manager', () => {
      const v = verdictOf({
        debate: { bull: null, bear: null, aggressive: null, conservative: null, neutral: null, researchManager: run().debate.researchManager },
      })
      expect(v.bull_case).toBeNull()
      expect(v.bear_case).toBeNull()
      expect(v.risk_dissent).toBeNull()
      expect(v.debate_note).toMatch(/not recorded/)
      expect(v.debate_note).toMatch(/research_manager_view/)
      expect(v.research_manager_view!.length).toBeLessThanOrEqual(600)
      expect(v.research_manager_view).toContain('I side with the bear.')
      expect(v.research_manager_view).toContain('Free cash flow is -$46.9B.')
    })

    it('treats empty debate text as not recorded', () => {
      const v = verdictOf({
        debate: { bull: '', bear: '  ', aggressive: '', conservative: '', neutral: '', researchManager: null },
      })
      expect(v.bull_case).toBeNull()
      expect(v.risk_dissent).toBeNull()
      expect(v.debate_note).toMatch(/not recorded/)
      expect(v).not.toHaveProperty('research_manager_view')
    })
  })

  describe('rationale', () => {
    it('is bounded, keeps the ruling and the levels, and flags the cut', () => {
      const v = verdictOf()
      expect(LONG_RATIONALE.length).toBeGreaterThan(3000)
      expect(v.rationale.length).toBeLessThanOrEqual(1500)
      expect(v.rationale_truncated).toBe(true)
      expect(v.rationale.startsWith('My ruling is HOLD.')).toBe(true)
      expect(v.rationale).toContain('No new capital below 250.72.')
      expect(v.rationale).toContain('Hard exit below 226.13 regardless of volume.')
    })

    it('passes a short rationale through', () => {
      const v = verdictOf({ decision: { rating: 'buy', confidence: 61, rationale: 'Buy above $240.' } })
      expect(v.rationale).toBe('Buy above $240.')
      expect(v.rationale_truncated).toBe(false)
    })
  })

  describe('runs without a verdict', () => {
    it('reports a running run by status alone', () => {
      expect(buildRunVerdict(run({ status: 'running', finishedAt: null, decision: null }), NOW)).toEqual({
        runId: 'run-1', symbol: 'US.AMZN', status: 'running', finishedAt: null, age_days: null,
        run_url: '/research/US.AMZN?run=run-1', rating: null, no_verdict_reason: 'the run is still in progress',
      })
    })

    it('carries the recorded failure', () => {
      const v = buildRunVerdict(run({ status: 'failed', error: 'no data from the agents service for 90s', decision: null }), NOW)
      expect(v).toMatchObject({ status: 'failed', rating: null, no_verdict_reason: 'run failed: no data from the agents service for 90s' })
    })

    it('says when a completed run stored no decision', () => {
      const v = buildRunVerdict(run({ decision: null }), NOW)
      expect(v).toMatchObject({ status: 'complete', rating: null, no_verdict_reason: 'the run completed without a decision' })
    })
  })

  it('keeps a failed run that still reached a decision, with its failure', () => {
    const v = verdictOf({ status: 'failed', error: 'stream ended without terminal event' })
    expect(v.rating).toBe('hold')
    expect(v.status).toBe('failed')
    expect(v.error).toBe('stream ended without terminal event')
  })
})
