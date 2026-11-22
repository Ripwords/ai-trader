import { defineEventHandler, getRouterParam } from 'h3'
import { getOwnerId } from '../../../db/repo'
import { deleteMemory } from '../../../lib/chat-memory'

/** Deleting a memory that is already gone succeeds: the list ends up the same. */
export default defineEventHandler(async (event) => {
  await deleteMemory(await getOwnerId(), getRouterParam(event, 'id') ?? '')
  return { ok: true }
})
