import { defineEventHandler } from 'h3'
import { PROMPT_REGISTRY } from '../../lib/prompts/registry'
import { readPromptOverrides } from '../../lib/prompts/store'
import { requireInternalBearer } from './_guard'

/**
 * The debate's prompt overrides, keyed by the api's prompt name. The api reads
 * them at the start of every run; prompts without an override are absent.
 */
export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const stored = await readPromptOverrides()
  const overrides: Record<string, string> = {}
  for (const meta of PROMPT_REGISTRY) {
    const text = stored[meta.id]
    if (meta.engine === 'agents' && text !== undefined) overrides[meta.agentName] = text
  }
  return { overrides }
})
