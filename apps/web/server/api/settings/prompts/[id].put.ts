import { createError, defineEventHandler, readBody } from 'h3'
import { z } from 'zod'
import type { PromptSaveResponse } from '../../../../types/prompts'
import { deletePromptOverride, writePromptOverride } from '../../../lib/prompts/store'
import { validatePromptText } from '../../../lib/prompts/validate'
import { defaultFor, loadAgentsDefaults } from '../../../lib/prompts/views'
import { promptParam } from './_params'

const bodySchema = z.object({ text: z.string() })

export default defineEventHandler(async (event): Promise<PromptSaveResponse> => {
  const meta = promptParam(event)
  const body = bodySchema.safeParse(await readBody(event))
  if (!body.success) throw createError({ statusCode: 400, statusMessage: 'Body must be { text: string }.' })
  const { text } = body.data

  const agents = meta.engine === 'agents' ? await loadAgentsDefaults() : null
  if (agents && !agents.ok) throw createError({ statusCode: 503, statusMessage: agents.error })
  const def = defaultFor(meta, agents ?? { ok: true, defaults: {} })
  if (!def) throw createError({ statusCode: 503, statusMessage: `The agents service has no default for ${meta.id}.` })

  // Saving the default text is a reset: keep following future default changes.
  if (text === def.text) {
    await deletePromptOverride(meta.id)
    return { modified: false, warnings: [] }
  }
  const check = validatePromptText(text, { engine: meta.engine, placeholders: def.placeholders, contract: meta.contract })
  if (!check.ok) throw createError({ statusCode: 400, statusMessage: check.error })
  await writePromptOverride(meta.id, text)
  return { modified: true, warnings: check.warnings }
})
