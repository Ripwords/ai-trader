import { defineEventHandler } from 'h3'
import { deletePromptOverride } from '../../../lib/prompts/store'
import { promptParam } from './_params'

export default defineEventHandler(async (event) => {
  const meta = promptParam(event)
  await deletePromptOverride(meta.id)
  return { ok: true }
})
