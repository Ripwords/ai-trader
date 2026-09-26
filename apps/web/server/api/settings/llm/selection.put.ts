import { defineEventHandler, readValidatedBody } from 'h3'
import { llmSettingsSchema } from '../../../../types/llm'
import { saveLlmSettings } from '../../../lib/llm-settings'

export default defineEventHandler(async (event) => {
  const selection = await readValidatedBody(event, llmSettingsSchema.parse)
  await saveLlmSettings(selection)
  return { selection }
})
