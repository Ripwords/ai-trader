import { defineEventHandler, getRouterParam } from 'h3'
import { getOwnerId, getThread } from '../../../db/repo'
import { chatStreams } from '../../../lib/chat-streams'
import { within } from '../../../lib/within'

/**
 * POST /api/chat/:id/stop
 *
 * Aborts the thread's reply on the server. The partial reply is saved with
 * `metadata.stopped`, and subscribers see the stream end.
 */
const SETTLE_MS = 5_000

export default defineEventHandler(async (event) => {
  const threadId = getRouterParam(event, 'id') ?? ''
  const owned = await getThread(await getOwnerId(), threadId)
  const stopping = owned ? chatStreams.stop(threadId) : null
  if (!stopping) return { stopped: false }
  // Answer once the partial reply is saved, so a reload right after shows it.
  // A tool that ignores the abort can hold the generation open past this.
  await within<unknown>(stopping.done, SETTLE_MS, null)
  return { stopped: true }
})
