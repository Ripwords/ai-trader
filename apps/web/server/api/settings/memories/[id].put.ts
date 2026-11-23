import { defineEventHandler, getRouterParam } from 'h3'
import { getOwnerId } from '../../../db/repo'
import { updateMemory } from '../../../lib/chat-memory'
import { memoryContent, memoryOrThrow } from './_shared'

export default defineEventHandler(async (event) => {
  const content = await memoryContent(event)
  return memoryOrThrow(await updateMemory(await getOwnerId(), getRouterParam(event, 'id') ?? '', content, 'manual'))
})
