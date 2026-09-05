import { describe, it, expect } from 'vitest'
import { estimateCost } from '../../server/lib/llm-cost'
import { MODEL_PRICING } from '../../server/lib/model-pricing'

/**
 * estimateCost returns 0 for any model missing from its table, so a gap reads
 * as "this turn was free" rather than as an error. deepseek/deepseek-v4-pro —
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

  it('still returns 0 for a genuinely unknown model', () => {
    expect(estimateCost('acme/does-not-exist', 1_000_000, 1_000_000)).toBe(0)
  })
})
