import { createError, defineEventHandler } from 'h3'
import type { ModelRole } from '../../../types/llm'
import { getModelConfig, type ModelConfig } from '../../lib/llm-settings'
import { requireInternalBearer } from './_guard'

function toWire(config: ModelConfig) {
  return { kind: config.kind, model_id: config.modelId, api_key: config.apiKey, base_url: config.baseUrl }
}

/**
 * The api's debate reads its models here, so the decrypted keys only travel
 * between containers over the bearer-guarded internal network.
 */
export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const roles: ModelRole[] = ['chat', 'quick']
  const [chat, quick] = await Promise.all(roles.map(getModelConfig))
  if (!chat || !quick) {
    throw createError({ statusCode: 409, statusMessage: 'llm_not_configured', data: { code: 'llm_not_configured' } })
  }
  return { chat: toWire(chat), quick: toWire(quick) }
})
