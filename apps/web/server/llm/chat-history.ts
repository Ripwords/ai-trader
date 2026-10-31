import { pruneMessages, type ModelMessage } from 'ai'

/**
 * Every turn resends the whole thread, and tool results (dossiers, bar series,
 * reports) are most of it. Keep tool data for the previous turn only, so a
 * follow-up on the last answer still has its numbers, and drop it from older
 * turns. The model's own answers stay, so it still knows what it concluded and
 * can call a tool again for detail.
 */
export function trimHistory(messages: ModelMessage[]): ModelMessage[] {
  const userAt = messages.flatMap((m, i) => m.role === 'user' ? [i] : [])
  if (userAt.length < 3) return messages
  const keep = messages.length - userAt[userAt.length - 2]!
  return pruneMessages({ messages, toolCalls: `before-last-${keep}-messages`, emptyMessages: 'remove' })
}
