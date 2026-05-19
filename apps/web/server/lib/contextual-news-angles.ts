import { generateObject } from 'ai'
import { z } from 'zod'
import { buildModel } from '../llm/model'
import { recordUsageSafely } from './llm-cost'

export interface DeriveAnglesArgs {
  symbol: string
  companyName?: string
  sector?: string
}

const AnglesSchema = z.object({
  queries: z.array(z.string()).max(8),
})

const SYSTEM_PROMPT = [
  'You generate short web-search queries that surface the MACRO, SECTOR,',
  'and PEER/GEOPOLITICAL news that could explain why a given stock moved.',
  'Do NOT include the company itself — ticker-specific news is fetched',
  'separately. Focus on: the sector and close competitors, supply-chain',
  'or regulatory exposure, and commodities/geopolitics relevant to this',
  'company. Return 2-4 concise queries (3-7 words each).',
].join(' ')

export async function deriveAngles(args: DeriveAnglesArgs): Promise<string[]> {
  const who = [args.companyName, `(${args.symbol})`, args.sector ? `sector: ${args.sector}` : '']
    .filter(Boolean)
    .join(' ')
  try {
    const { object, usage } = await generateObject({
      model: buildModel(),
      schema: AnglesSchema,
      system: SYSTEM_PROMPT,
      prompt: `Company: ${who}\nReturn macro/sector/peer search queries.`,
    })
    if (usage) {
      await recordUsageSafely({
        source: 'contextual-news-angles',
        modelSpec: process.env.LLM_MODEL || 'anthropic/claude-sonnet-4-6',
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      })
    }
    return object.queries
      .map(q => q.trim())
      .filter(q => q.length > 0)
      .slice(0, 4)
  } catch {
    return []
  }
}
