import { generateObject } from 'ai'
import { z } from 'zod'
import { resolveModel } from '../llm/model'
import { recordUsageSafely } from './llm-cost'
import { getPrompt } from './prompts'

export interface DeriveAnglesArgs {
  symbol: string
  companyName?: string
  sector?: string
}

const AnglesSchema = z.object({
  queries: z.array(z.string()).max(8),
})

export interface DeriveAnglesResult {
  queries: string[]
  failed: boolean
}

export async function deriveAngles(args: DeriveAnglesArgs): Promise<DeriveAnglesResult> {
  const who = [args.companyName, `(${args.symbol})`, args.sector ? `sector: ${args.sector}` : '']
    .filter(Boolean)
    .join(' ')
  try {
    const resolved = await resolveModel('quick')
    const { object, usage } = await generateObject({
      model: resolved.model,
      schema: AnglesSchema,
      system: await getPrompt('news.contextual_angles'),
      prompt: `Company: ${who}\nReturn macro/sector/peer search queries.`,
    })
    if (usage) {
      await recordUsageSafely({
        source: 'contextual-news-angles',
        modelSpec: resolved.spec,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      })
    }
    return {
      queries: object.queries
        .map(q => q.trim())
        .filter(q => q.length > 0)
        .slice(0, 4),
      failed: false,
    }
  } catch {
    return { queries: [], failed: true }
  }
}
