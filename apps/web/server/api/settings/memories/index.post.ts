import { defineEventHandler } from 'h3'
import { getOwnerId } from '../../../db/repo'
import { addMemory } from '../../../lib/chat-memory'
import { memoryContent, memoryOrThrow } from './_shared'

export default defineEventHandler(async (event) => {
  const content = await memoryContent(event)
  return memoryOrThrow(await addMemory(await getOwnerId(), content, 'manual'))
})
