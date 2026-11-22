import { defineEventHandler } from 'h3'
import { MEMORY_LIMIT, type MemoryListResponse } from '../../../../types/memory'
import { getOwnerId } from '../../../db/repo'
import { listMemories } from '../../../lib/chat-memory'

export default defineEventHandler(async (): Promise<MemoryListResponse> => ({
  memories: await listMemories(await getOwnerId()),
  limit: MEMORY_LIMIT,
}))
