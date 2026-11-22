import { generateObject } from 'ai'
import { z } from 'zod'
import { MEMORY_LIMIT } from '../../types/memory'
import { resolveModel } from '../llm/model'
import { applyMemoryWrites, listMemories } from './chat-memory'
import { planMemoryWrites } from './chat-memory-plan'
import { recordUsageSafely } from './llm-cost'
import { getPrompt } from './prompts'

export interface ChatTurn {
  ownerId: string
  /** The owner's newest message: the only source of memories. */
  userText: string
  /** The reply the owner was answering, so "yes, on purpose" can be read. */
  priorAssistantText: string
}

const OperationsSchema = z.object({
  operations: z.array(z.object({
    op: z.enum(['add', 'update']),
    ref: z.number().int().nullable(),
    content: z.string(),
  })).max(5),
})

const MAX_USER_CHARS = 4_000
const MAX_CONTEXT_CHARS = 1_500
const EXTRACT_TIMEOUT_MS = 30_000

// Runs queue here, one at a time, so each sees what the one before it saved.
// Otherwise two chats finishing together would both add the same fact.
let queue: Promise<void> = Promise.resolve()

/**
 * After a chat turn, save what the owner's message says about their standing
 * positions. Runs on the quick model, after the reply, and never throws: a
 * failure costs one missed memory, not the chat.
 */
export function rememberFromTurn(turn: ChatTurn): Promise<void> {
  const userText = turn.userText.trim()
  if (!userText || userText.startsWith('/')) return Promise.resolve()
  queue = queue.then(() => extract({ ...turn, userText })).catch((err: unknown) => {
    console.warn('[chat] memory extraction failed; nothing was saved from this message', err)
  })
  return queue
}

async function extract(turn: ChatTurn): Promise<void> {
  const saved = await listMemories(turn.ownerId)
  const resolved = await resolveModel('quick')
  const { object, usage } = await generateObject({
    model: resolved.model,
    schema: OperationsSchema,
    system: await getPrompt('chat.memory'),
    prompt: extractionPrompt(saved.map(m => m.content), turn),
    abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
  })
  if (usage) {
    await recordUsageSafely({
      source: 'chat-memory',
      modelSpec: resolved.spec,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    })
  }
  const writes = planMemoryWrites(saved, object.operations)
  if (writes.length > 0) await applyMemoryWrites(turn.ownerId, writes, 'auto')
}

function extractionPrompt(saved: readonly string[], turn: ChatTurn): string {
  const context = turn.priorAssistantText.trim().slice(-MAX_CONTEXT_CHARS)
  return [
    `SAVED MEMORIES (${saved.length} of ${MEMORY_LIMIT}${saved.length >= MEMORY_LIMIT ? '; the list is full, only update' : ''}):`,
    ...(saved.length > 0 ? saved.map((m, i) => `${i + 1}. ${m}`) : ['(none)']),
    '',
    'ASSISTANT\'S PREVIOUS MESSAGE (context only, never a source):',
    context || '(none)',
    '',
    'OWNER\'S LATEST MESSAGE:',
    turn.userText.slice(0, MAX_USER_CHARS),
  ].join('\n')
}
