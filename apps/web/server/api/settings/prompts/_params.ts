import type { H3Event } from 'h3'
import { createError, getRouterParam } from 'h3'
import { findPrompt, type PromptMeta } from '../../../lib/prompts/registry'

export function promptParam(event: H3Event): PromptMeta {
  const id = getRouterParam(event, 'id') ?? ''
  const meta = findPrompt(decodeURIComponent(id))
  if (!meta) throw createError({ statusCode: 404, statusMessage: `Unknown prompt "${id}".` })
  return meta
}
