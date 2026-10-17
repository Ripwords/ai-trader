import { defineEventHandler } from 'h3'
import type { PromptListResponse } from '../../../../types/prompts'
import { readPromptOverrides } from '../../../lib/prompts/store'
import { listViews, loadAgentsDefaults } from '../../../lib/prompts/views'

export default defineEventHandler(async (): Promise<PromptListResponse> => {
  const [overrides, agents] = await Promise.all([readPromptOverrides(), loadAgentsDefaults()])
  return { prompts: listViews(overrides, agents), agentsError: agents.ok ? null : agents.error }
})
