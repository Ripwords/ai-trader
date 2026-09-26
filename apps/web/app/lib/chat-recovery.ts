import { isTextUIPart, type ChatStatus, type UIMessage } from 'ai'

/** What the chat shows under the thread when the last turn did not end normally. */
export type ChatInterruption =
  | { kind: 'error'; message: string }
  | { kind: 'stopped' }
  | { kind: 'no-reply' }

export type ReplyEnding = Exclude<ChatInterruption, { kind: 'no-reply' }>

/** The slice of the AI SDK Chat that recovery drives. */
export interface ResumableChat {
  messages: UIMessage[]
  status: ChatStatus
  error: Error | undefined
  clearError(): void
  resumeStream(): Promise<void>
}

/** How a saved reply ended, from the metadata the server stamps on early endings. */
export function replyEnding(message: UIMessage): ReplyEnding | null {
  if (message.role !== 'assistant') return null
  const meta = message.metadata as { stopped?: boolean; error?: string } | undefined
  if (meta?.error) return { kind: 'error', message: meta.error }
  if (meta?.stopped) return { kind: 'stopped' }
  return null
}

export function interruptionOf(state: {
  status: ChatStatus
  error: Error | undefined
  messages: UIMessage[]
  /** A resume or reload is under way; its outcome decides. */
  settling: boolean
}): ChatInterruption | null {
  if (state.settling) return null
  if (state.status === 'error') return { kind: 'error', message: state.error?.message || 'The reply was interrupted.' }
  if (state.status !== 'ready') return null
  const last = state.messages.at(-1)
  if (!last) return null
  if (last.role === 'user') return { kind: 'no-reply' }
  return replyEnding(last)
}

/** How a chat request ended, as the AI SDK's onFinish reports it. */
export interface RequestEnding {
  isAbort: boolean
  isError: boolean
  isDisconnect: boolean
  finishReason?: string
}

/**
 * A stream that closed with no finish chunk and no error. The server ends a
 * reply stopped from another tab with an `abort` chunk, which the SDK ignores,
 * and a proxy can cut a stream cleanly. Either way the reply on screen is stale.
 */
export function endedWithoutFinish(e: RequestEnding): boolean {
  return !e.isAbort && !e.isError && !e.finishReason
}

// fetch fails with a TypeError when the connection drops; browsers word it
// differently (Chrome, Firefox, Safari). Other TypeErrors are bugs, not drops.
const CONNECTION_DROP = /fetch|network|load failed|connection|terminated|body stream|input stream/i

/**
 * What to do once a request has ended. Only a dropped connection or a stale
 * stream is recovered; an HTTP error (no provider configured, a server error)
 * or the model's own error stays on screen.
 */
export function afterRequest(e: RequestEnding & { error: Error | undefined; refusedBusy: boolean }): 'follow-running' | 'recover' | null {
  if (e.isError) {
    if (e.refusedBusy) return 'follow-running'
    const dropped = e.isDisconnect || (e.error instanceof TypeError && CONNECTION_DROP.test(e.error.message))
    return dropped ? 'recover' : null
  }
  return endedWithoutFinish(e) ? 'recover' : null
}

function dropPartialReply(chat: ResumableChat) {
  if (chat.messages.at(-1)?.role === 'assistant') chat.messages = chat.messages.slice(0, -1)
}

/**
 * Follow the thread's reply if the server is still generating it. The server
 * answers 204 once the reply is saved, so a thread that still ends on the
 * question has finished since it was loaded: reload it.
 *
 * `takeCutShort` reports (and forgets) whether the stream just followed closed
 * without a finish; the reply is then fetched again, from the server's replay
 * or the saved thread.
 */
export async function reattach(
  chat: ResumableChat,
  reload: () => Promise<void>,
  takeCutShort: () => boolean = () => false,
): Promise<void> {
  await chat.resumeStream()
  if (chat.status === 'ready' && takeCutShort()) {
    dropPartialReply(chat)
    await chat.resumeStream()
  }
  if (chat.status === 'ready' && chat.messages.at(-1)?.role === 'user') await reload()
}

/**
 * After the stream broke: wait for the network, drop the partial reply (the
 * server replays it from the start), and attach once. A second failure stays
 * on screen as the error.
 */
export async function recoverReply(
  chat: ResumableChat,
  opts: { reload: () => Promise<void>; online: () => Promise<void>; takeCutShort?: () => boolean },
): Promise<void> {
  await opts.online()
  dropPartialReply(chat)
  // A 204 leaves the status alone; the stale error would hide the reload below.
  chat.clearError()
  await reattach(chat, opts.reload, opts.takeCutShort)
}

/**
 * The server refused a send because the thread is already generating (another
 * tab asked first). Show the thread as saved, follow its reply, and return the
 * text of the refused question if it was never saved, so it can be asked again.
 */
export async function followRunningReply(
  chat: ResumableChat,
  reload: () => Promise<void>,
  takeCutShort?: () => boolean,
): Promise<string | null> {
  const asked = chat.messages.at(-1)
  chat.clearError()
  await reload()
  await reattach(chat, reload, takeCutShort)
  if (asked?.role !== 'user' || chat.messages.some(m => m.id === asked.id)) return null
  return asked.parts.filter(isTextUIPart).map(p => p.text).join('')
}
