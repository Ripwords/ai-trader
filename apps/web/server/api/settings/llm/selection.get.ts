import { defineEventHandler } from 'h3'
import { getLlmSettings } from '../../../lib/llm-settings'

export default defineEventHandler(async () => ({ selection: await getLlmSettings() }))
