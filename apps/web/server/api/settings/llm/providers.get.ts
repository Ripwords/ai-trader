import { defineEventHandler } from 'h3'
import { listProviders } from '../../../lib/llm-providers'

export default defineEventHandler(async () => ({ providers: await listProviders() }))
