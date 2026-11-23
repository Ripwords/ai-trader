import { describe, it, expect } from 'vitest'
import { debateCardView } from '../../app/utils/debate-card'

const verdict = {
  runId: 'run-1', symbol: 'US.AMZN', status: 'complete', finishedAt: '2026-11-19T11:00:00.000Z', age_days: 3,
  run_url: '/research/US.AMZN?run=run-1',
  rating: 'hold', rating_cap: { original_rating: 'buy', reason: 'price > 2x fair value' },
  confidence: 33, confidence_measures: 'probability the rating is right over 7 trading days', confidence_missing_reason: null,
  valuation: { status: 'unavailable', reason: 'none' },
  bull_case: 'AWS grew 39.3%.', bear_case: 'Debt rose to $173.1B.', risk_dissent: null, debate_note: null,
  rationale: 'Hold above $226.13.', rationale_truncated: true,
}

describe('debateCardView', () => {
  it('reads progress yields as steps with no verdict', () => {
    expect(debateCardView({ runId: 'run-1', events: [{ type: 'node-start', node: 'market' }, { type: 'node-start', node: 'trader' }] }))
      .toEqual({ steps: ['market', 'trader'], verdict: null, error: null })
  })

  it('reads the stored verdict', () => {
    expect(debateCardView(verdict)).toEqual({
      steps: [],
      error: null,
      verdict: {
        rating: 'hold', ownerVerdict: null, cappedFrom: 'buy', capReason: 'price > 2x fair value',
        confidence: 33, rationale: 'Hold above $226.13.', rationaleTruncated: true,
        bullCase: 'AWS grew 39.3%.', bearCase: 'Debt rose to $173.1B.', runUrl: '/research/US.AMZN?run=run-1',
      },
    })
  })

  it('reads the owner verdict, and ignores a value it does not know', () => {
    expect(debateCardView({ ...verdict, owner_verdict: 'do-not-add' }).verdict?.ownerVerdict).toBe('do-not-add')
    expect(debateCardView({ ...verdict, owner_verdict: null }).verdict?.ownerVerdict).toBeNull()
    expect(debateCardView({ ...verdict, owner_verdict: 'liquidate' }).verdict?.ownerVerdict).toBeNull()
  })

  it('keeps the failure beside a verdict the run still reached', () => {
    expect(debateCardView({ ...verdict, error: 'run failed: boom' })).toMatchObject({ error: 'run failed: boom', verdict: { rating: 'hold' } })
  })

  it('reads a run that ended without a decision', () => {
    expect(debateCardView({ runId: 'run-1', rating: null, error: 'no decision emitted' }))
      .toEqual({ steps: [], verdict: null, error: 'no decision emitted' })
  })

  it('still reads a result saved before the verdict was compacted', () => {
    expect(debateCardView({
      runId: 'run-0', events: [{ type: 'node-start', node: 'market' }], rating: 'sell', confidence: null, rationale: 'Sell.',
    })).toEqual({
      steps: ['market'],
      error: null,
      verdict: {
        rating: 'sell', ownerVerdict: null, cappedFrom: null, capReason: null, confidence: null, rationale: 'Sell.', rationaleTruncated: false,
        bullCase: null, bearCase: null, runUrl: null,
      },
    })
  })

  it('reads nothing from a missing output', () => {
    expect(debateCardView(undefined)).toEqual({ steps: [], verdict: null, error: null })
  })
})
