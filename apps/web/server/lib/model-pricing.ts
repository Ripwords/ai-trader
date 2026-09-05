/**
 * USD per 1M tokens, keyed by the `<provider>/<model-id>` LLM_MODEL spec.
 *
 * Hardcoded mirror of apps/api/app/services/agents/pricing.py MODELS. Keep the
 * two in sync manually until the /internal/pricing route becomes a live fetch.
 *
 * This is the single table behind both the cost estimator (lib/llm-cost.ts) and
 * the /internal/pricing mirror the TradingAgents cost-cap layer reads. They used
 * to keep separate copies, which drifted: the estimator was missing
 * deepseek-v4-pro entirely — costing every turn on it at $0 — and carried a
 * v4-flash rate that matched neither the Python table nor DeepSeek's list price.
 *
 * DeepSeek's deepseek-chat / deepseek-reasoner aliases are deprecated and out of
 * `GET /models`, but still resolve server-side, so their rates stay listed:
 * usage recorded under an old spec should not silently price at zero.
 */
export interface ModelRate { input_per_1m: number; output_per_1m: number }

export const MODEL_PRICING = {
  'anthropic/claude-sonnet-4-6':         { input_per_1m: 3.00,  output_per_1m: 15.00 },
  'anthropic/claude-opus-4-7':           { input_per_1m: 15.00, output_per_1m: 75.00 },
  'anthropic/claude-haiku-4-5-20251001': { input_per_1m: 1.00,  output_per_1m: 5.00 },
  'openai/gpt-4o':                       { input_per_1m: 2.50,  output_per_1m: 10.00 },
  'openai/gpt-4o-mini':                  { input_per_1m: 0.15,  output_per_1m: 0.60 },
  'google/gemini-2.5-pro':               { input_per_1m: 1.25,  output_per_1m: 5.00 },
  'google/gemini-2.5-flash':             { input_per_1m: 0.075, output_per_1m: 0.30 },
  'deepseek/deepseek-v4-pro':            { input_per_1m: 0.55,  output_per_1m: 2.20 },
  'deepseek/deepseek-v4-flash':          { input_per_1m: 0.07,  output_per_1m: 0.28 },
  'deepseek/deepseek-chat':              { input_per_1m: 0.07,  output_per_1m: 0.28 },
  'deepseek/deepseek-reasoner':          { input_per_1m: 0.55,  output_per_1m: 2.20 },
} as const satisfies Record<string, ModelRate>
