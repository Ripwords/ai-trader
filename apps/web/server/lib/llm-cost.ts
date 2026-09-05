import { MODEL_PRICING } from './model-pricing'

export function estimateCost(modelSpec: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[modelSpec as keyof typeof MODEL_PRICING]
  if (!p) return 0
  return (inputTokens * p.input_per_1m + outputTokens * p.output_per_1m) / 1_000_000
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
