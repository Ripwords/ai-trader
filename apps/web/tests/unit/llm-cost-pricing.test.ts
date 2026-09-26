import { describe, it, expect } from 'vitest'
import { estimateCost } from '../../server/lib/llm-cost'
import { MODEL_PRICING } from '../../server/lib/model-pricing'

/**
 * A model missing from the table used to price at 0, so a gap read as "this
 * turn was free". deepseek/deepseek-v4-pro —
 * the model this deployment actually runs — was missing, and the v4-flash rate
 * disagreed with apps/api/app/services/agents/pricing.py. One table now backs
 * both the estimator and the /internal/pricing mirror.
 */
describe('llm cost estimation', () => {
  it('prices the deepseek models that still exist', () => {
    // 1M input + 1M output at 0.55 / 2.20.
    expect(estimateCost('deepseek/deepseek-v4-pro', 1_000_000, 1_000_000)).toBeCloseTo(2.75, 6)
    expect(estimateCost('deepseek/deepseek-v4-flash', 1_000_000, 1_000_000)).toBeCloseTo(0.35, 6)
  })

  it('prices every model in the shared table (no silent zeroes)', () => {
    for (const spec of Object.keys(MODEL_PRICING)) {
      expect(estimateCost(spec, 1_000_000, 0), `${spec} priced at 0`).toBeGreaterThan(0)
    }
  })

  it('returns null for an unpriced model rather than calling it free', () => {
    expect(estimateCost('openai_compatible/qwen3:8b', 1_000_000, 1_000_000)).toBeNull()
  })
})
