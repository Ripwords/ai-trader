/** A failed chat request, in words the chat can show. */
export interface ChatHttpError {
  status: number
  message: string
  /** The server's `data.code`, e.g. `chat_busy` or `llm_not_configured`. */
  code: string | null
}

export function describeHttpError(status: number, bodyText: string): ChatHttpError {
  let message: string | null = null
  let code: string | null = null
  try {
    const body: unknown = JSON.parse(bodyText)
    if (typeof body === 'object' && body !== null) {
      const fields = body as { message?: unknown; statusMessage?: unknown; data?: unknown }
      message = [fields.message, fields.statusMessage].find((m): m is string => typeof m === 'string' && m.length > 0) ?? null
      const data = fields.data
      if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'string') code = data.code
    }
  } catch {
    const text = bodyText.trim()
    if (text && text.length <= 200 && !text.startsWith('<')) message = text
  }
  return { status, message: `${message ?? 'The server could not answer.'} (HTTP ${status})`, code }
}

/**
 * The `fetch` for the chat's DefaultChatTransport.
 *
 * The AI SDK sends the resume request (GET) with no abort signal, and
 * `chat.stop()` only aborts a send, so a resumed reply would keep streaming
 * into whatever thread is on screen next. Each resume gets a signal that
 * `abortResume` fires.
 *
 * The SDK shows a failed response's raw body as the error; this swaps in a
 * readable message and reports the error's code.
 */
export function createChatFetch(opts: {
  onChatId: (id: string) => void
  /** Called for every response: the error, or null when it succeeded. */
  onRequestError: (error: ChatHttpError | null) => void
  fetch?: typeof fetch
}) {
  let resume: AbortController | null = null
  const base = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))

  const chatFetch: typeof fetch = async (input, init) => {
    let request = init
    if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
      resume?.abort()
      resume = new AbortController()
      request = { ...init, signal: resume.signal }
    }
    const res = await base(input, request)
    const chatId = res.headers.get('X-Chat-Id')
    if (chatId) opts.onChatId(chatId)
    if (res.ok) {
      opts.onRequestError(null)
      return res
    }
    const error = describeHttpError(res.status, await res.text().catch(() => ''))
    opts.onRequestError(error)
    return new Response(error.message, { status: res.status, statusText: res.statusText })
  }

  return {
    fetch: chatFetch,
    abortResume() {
      resume?.abort()
      resume = null
    },
  }
}
