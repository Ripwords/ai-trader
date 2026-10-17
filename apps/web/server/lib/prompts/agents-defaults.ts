import { z } from 'zod'

const defaultsSchema = z.record(
  z.string(),
  z.object({ text: z.string(), placeholders: z.array(z.string()) }),
)

export type AgentsDefaults = z.infer<typeof defaultsSchema>

/**
 * The debate prompts' default text and `{placeholders}`, keyed by the api's
 * name (`market_analyst`, `confidence_judge`, …). They live in the Python
 * package, so the api is the only source. Throws when it is unreachable.
 */
export async function fetchAgentsDefaults(): Promise<AgentsDefaults> {
  const apiBase = process.env.NUXT_API_BASE_URL ?? 'http://api:8000'
  const internalBearer = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER ?? ''
  const res = await fetch(`${apiBase}/agents/prompts/defaults`, {
    headers: { authorization: `Bearer ${internalBearer}` },
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) throw new Error(`agents service answered ${res.status}`)
  return defaultsSchema.parse(await res.json())
}
