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
  it('prices the deepseek models at their peak list rates', () => {
    // 1M input + 1M output: flash at 0.30 / 1.20, v4-pro at 1.32 / 3.96.
    expect(estimateCost('deepseek/deepseek-flash', 1_000_000, 1_000_000)).toBeCloseTo(1.50, 6)
    expect(estimateCost('deepseek/deepseek-v4-pro', 1_000_000, 1_000_000)).toBeCloseTo(5.28, 6)
    // The retired v4-flash name is served and billed as deepseek-flash.
    expect(estimateCost('deepseek/deepseek-v4-flash', 1_000_000, 1_000_000)).toBeCloseTo(1.50, 6)
  })

  it('prices every model in the shared table (no silent zeroes)', () => {
    for (const spec of Object.keys(MODEL_PRICING)) {
      expect(estimateCost(spec, 1_000_000, 0), `${spec} priced at 0`).toBeGreaterThan(0)
    }
  })

  it('returns null for an unpriced model rather than calling it free', () => {
    expect(estimateCost('openrouter/qwen/qwen3-32b', 1_000_000, 1_000_000)).toBeNull()
  })
})
