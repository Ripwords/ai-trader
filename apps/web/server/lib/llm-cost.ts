// USD per 1M tokens. Conservative public list prices.
const PRICES: Record<string, { input: number; output: number }> = {
  'anthropic/claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'anthropic/claude-opus-4-7': { input: 15.00, output: 75.00 },
  'openai/gpt-4o': { input: 2.50, output: 10.00 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
  'google/gemini-2.5-pro': { input: 1.25, output: 5.00 },
  'deepseek/deepseek-v4-flash': { input: 0.27, output: 1.10 },
}

export function estimateCost(modelSpec: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[modelSpec]
  if (!p) return 0
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

export interface RecordUsageArgs {
  source: string
  modelSpec: string
  inputTokens: number
  outputTokens: number
}

// Wrapper that swallows DB errors so usage tracking never breaks the actual LLM flow.
export async function recordUsageSafely(args: RecordUsageArgs): Promise<void> {
  try {
    const { getOwnerId, recordLlmUsage } = await import('../db/repo')
    const ownerId = await getOwnerId()
    const cost = estimateCost(args.modelSpec, args.inputTokens, args.outputTokens)
    await recordLlmUsage(ownerId, {
      source: args.source,
      modelSpec: args.modelSpec,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      totalTokens: args.inputTokens + args.outputTokens,
      estimatedCostUsd: cost,
    })
  } catch (err) {
    console.error('[llm-cost] record failed', err)
  }
}
