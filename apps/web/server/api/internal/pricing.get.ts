import { defineEventHandler } from 'h3'
import { requireInternalBearer } from './_guard'

/**
 * Hardcoded mirror of apps/api/app/services/agents/pricing.py MODELS table.
 * The TradingAgents toolkit / cost-cap layer reads this to estimate $/run
 * without round-tripping to the Python api. Keep in sync manually until
 * Task 9, when this becomes a live api fetch.
 */
const MODELS = {
  'anthropic/claude-sonnet-4-6':         { input_per_1m: 3.00,  output_per_1m: 15.00 },
  'anthropic/claude-opus-4-7':           { input_per_1m: 15.00, output_per_1m: 75.00 },
  'anthropic/claude-haiku-4-5-20251001': { input_per_1m: 1.00,  output_per_1m: 5.00 },
  'openai/gpt-4o':                       { input_per_1m: 2.50,  output_per_1m: 10.00 },
  'openai/gpt-4o-mini':                  { input_per_1m: 0.15,  output_per_1m: 0.60 },
  'google/gemini-2.5-pro':               { input_per_1m: 1.25,  output_per_1m: 5.00 },
  'google/gemini-2.5-flash':             { input_per_1m: 0.075, output_per_1m: 0.30 },
  'deepseek/deepseek-v4-pro':            { input_per_1m: 0.55,  output_per_1m: 2.20 },
  'deepseek/deepseek-v4-flash':          { input_per_1m: 0.07,  output_per_1m: 0.28 },
} as const

export default defineEventHandler((event) => {
  requireInternalBearer(event)
  return { models: MODELS }
})
