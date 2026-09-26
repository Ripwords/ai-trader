import { UI_MESSAGE_STREAM_HEADERS, type UIMessageChunk } from 'ai'

export type ChatStreamStatus = 'streaming' | 'done' | 'error' | 'aborted'

export interface ActiveChatStream {
  readonly threadId: string
  readonly chunks: UIMessageChunk[]
  status: ChatStreamStatus
  readonly abort: AbortController
  /** Resolves with the terminal status once the producer has ended. */
  readonly done: Promise<Exclude<ChatStreamStatus, 'streaming'>>
}

interface Entry extends ActiveChatStream {
  /** Settles on the next chunk or ending; subscribers wait on it. */
  changed: Promise<void>
  wake: () => void
}

export class ChatStreamBusyError extends Error {
  constructor(threadId: string) {
    super(`thread ${threadId} already has a reply in progress`)
  }
}

/**
 * Generations keyed by chat thread. A generation runs to its end whether or
 * not anyone is listening; subscribers replay the chunks produced so far and
 * then follow the rest. An entry leaves the registry when its producer ends,
 * by which point the reply has been persisted, so a reader arriving later
 * loads it from the thread instead.
 */
export class ChatStreamRegistry {
  private entries = new Map<string, Entry>()

  isActive(threadId: string): boolean {
    return this.entries.has(threadId)
  }

  start(threadId: string, produce: (signal: AbortSignal) => ReadableStream<UIMessageChunk>): ActiveChatStream {
    if (this.entries.has(threadId)) throw new ChatStreamBusyError(threadId)
    const abort = new AbortController()
    let resolveDone!: (s: Exclude<ChatStreamStatus, 'streaming'>) => void
    const entry: Entry = {
      threadId,
      chunks: [],
      status: 'streaming',
      abort,
      done: new Promise((r) => { resolveDone = r }),
      changed: Promise.resolve(),
      wake: () => {},
    }
    rearm(entry)
    this.entries.set(threadId, entry)

    void (async () => {
      let status: Exclude<ChatStreamStatus, 'streaming'> = 'done'
      try {
        const reader = produce(abort.signal).getReader()
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (value.type === 'abort') status = 'aborted'
          else if (value.type === 'error' && status === 'done') status = 'error'
          push(entry, value)
        }
      }
      catch (err) {
        status = 'error'
        push(entry, { type: 'error', errorText: err instanceof Error ? err.message : String(err) })
      }
      entry.status = status
      this.entries.delete(threadId)
      entry.wake()
      resolveDone(entry.status)
    })()

    return entry
  }

  /** Replay-then-tail view of the thread's generation, or null if none is running. */
  subscribe(threadId: string): ReadableStream<UIMessageChunk> | null {
    const entry = this.entries.get(threadId)
    if (!entry) return null
    let next = 0
    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        while (next === entry.chunks.length && entry.status === 'streaming') await entry.changed
        if (next < entry.chunks.length) controller.enqueue(entry.chunks[next++]!)
        else controller.close()
      },
    })
  }

  /** Signals the generation to stop; it ends once the model and any running tool notice. */
  stop(threadId: string): ActiveChatStream | null {
    const entry = this.entries.get(threadId)
    entry?.abort.abort()
    return entry ?? null
  }
}

function rearm(entry: Entry) {
  entry.changed = new Promise((r) => { entry.wake = r })
}

function push(entry: Entry, chunk: UIMessageChunk) {
  entry.chunks.push(chunk)
  const wake = entry.wake
  rearm(entry)
  wake()
}

export const chatStreams = new ChatStreamRegistry()

const PING_MS = 15_000

/** The AI SDK's UI message stream wire format, plus comment pings so idle
 *  proxies keep the connection open while tools run. */
export function chatSseResponse(
  chunks: ReadableStream<UIMessageChunk>,
  opts: { pingMs?: number; headers?: Record<string, string> } = {},
): Response {
  const enc = new TextEncoder()
  const reader = chunks.getReader()
  let ping: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Node holds the status line and headers until the first body write;
      // this sends them (and X-Chat-Id) before any model work.
      controller.enqueue(enc.encode(': connected\n\n'))
      ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), opts.pingMs ?? PING_MS)
    },
    async pull(controller) {
      const { value, done } = await reader.read().catch((err: unknown) => {
        clearInterval(ping)
        throw err
      })
      if (done) {
        clearInterval(ping)
        controller.enqueue(enc.encode('data: [DONE]\n\n'))
        controller.close()
        return
      }
      controller.enqueue(enc.encode(`data: ${JSON.stringify(value)}\n\n`))
    },
    cancel() {
      clearInterval(ping)
      void reader.cancel()
    },
  })
  return new Response(body, { headers: { ...UI_MESSAGE_STREAM_HEADERS, ...opts.headers } })
}
