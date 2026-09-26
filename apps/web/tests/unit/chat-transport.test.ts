import { describe, expect, it, vi } from 'vitest'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { Chat } from '@ai-sdk/vue'
import { createChatFetch, describeHttpError, type ChatHttpError } from '../../app/lib/chat-transport'

const noop = () => {}

describe('describeHttpError', () => {
  it('reads the message and code from an h3 error body', () => {
    const body = JSON.stringify({
      statusCode: 409,
      statusMessage: 'llm_not_configured',
      message: 'No model provider is configured. Add one in Settings.',
      data: { code: 'llm_not_configured' },
    })
    expect(describeHttpError(409, body)).toEqual({
      status: 409,
      message: 'No model provider is configured. Add one in Settings. (HTTP 409)',
      code: 'llm_not_configured',
    })
  })

  it('falls back to the status message, then to the status', () => {
    expect(describeHttpError(500, JSON.stringify({ statusCode: 500, statusMessage: 'Server Error' })).message)
      .toBe('Server Error (HTTP 500)')
    expect(describeHttpError(502, '<html><body>Bad gateway</body></html>')).toEqual({
      status: 502,
      message: 'The server could not answer. (HTTP 502)',
      code: null,
    })
    expect(describeHttpError(503, 'upstream down').message).toBe('upstream down (HTTP 503)')
  })
})

describe('createChatFetch', () => {
  function setup(respond: (url: string, init?: RequestInit) => Response) {
    const seen: Array<RequestInit | undefined> = []
    const errors: Array<ChatHttpError | null> = []
    const chatIds: string[] = []
    const chat = createChatFetch({
      fetch: async (url, init) => {
        seen.push(init)
        return respond(String(url), init)
      },
      onChatId: id => chatIds.push(id),
      onRequestError: e => errors.push(e),
    })
    return { chat, seen, errors, chatIds }
  }

  it('gives each resume request a signal that abortResume fires', async () => {
    const { chat, seen } = setup(() => new Response(null, { status: 204 }))
    await chat.fetch('/api/chat/th-1/stream', { method: 'GET' })
    const signal = seen[0]?.signal
    expect(signal?.aborted).toBe(false)
    chat.abortResume()
    expect(signal?.aborted).toBe(true)
  })

  it('leaves the send request its own signal', async () => {
    const { chat, seen } = setup(() => new Response('ok'))
    const own = new AbortController()
    await chat.fetch('/api/chat', { method: 'POST', signal: own.signal })
    chat.abortResume()
    expect(seen[0]?.signal).toBe(own.signal)
    expect(own.signal.aborted).toBe(false)
  })

  it('reports the thread the server wrote to', async () => {
    const { chat, chatIds } = setup(() => new Response('ok', { headers: { 'X-Chat-Id': 'th-9' } }))
    await chat.fetch('/api/chat', { method: 'POST' })
    expect(chatIds).toEqual(['th-9'])
  })

  it('turns an HTTP error into a readable one and reports its code', async () => {
    const body = JSON.stringify({ statusCode: 409, message: 'a reply is still in progress', data: { code: 'chat_busy' } })
    const { chat, errors } = setup(() => new Response(body, { status: 409 }))
    const res = await chat.fetch('/api/chat', { method: 'POST' })
    expect(res.status).toBe(409)
    expect(await res.text()).toBe('a reply is still in progress (HTTP 409)')
    expect(errors).toEqual([{ status: 409, message: 'a reply is still in progress (HTTP 409)', code: 'chat_busy' }])
  })

  it('clears the reported error on a good response', async () => {
    const { chat, errors } = setup(() => new Response(null, { status: 204 }))
    await chat.fetch('/api/chat/th-1/stream', { method: 'GET' })
    expect(errors).toEqual([null])
  })
})

describe('createChatFetch with the AI SDK Chat', () => {
  const sse = (chunk: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`)

  it('stops following a resumed reply when abortResume is called', async () => {
    let server!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { server = c } })
    const transportFetch = createChatFetch({
      fetch: async (_url, init) => {
        init?.signal?.addEventListener('abort', () => server.error(new DOMException('aborted', 'AbortError')))
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      },
      onChatId: noop,
      onRequestError: noop,
    })
    const onFinish = vi.fn()
    const chat = new Chat<UIMessage>({
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'q' }] }],
      transport: new DefaultChatTransport({
        prepareReconnectToStreamRequest: () => ({ api: '/api/chat/th-1/stream' }),
        fetch: transportFetch.fetch,
      }),
      onFinish,
    })

    const resuming = chat.resumeStream()
    server.enqueue(sse({ type: 'start', messageId: 'a' }))
    server.enqueue(sse({ type: 'text-start', id: 't' }))
    server.enqueue(sse({ type: 'text-delta', id: 't', delta: 'from thread A' }))
    for (let i = 0; i < 20 && chat.status !== 'streaming'; i++) await new Promise(r => setTimeout(r, 5))
    expect(chat.status).toBe('streaming')

    transportFetch.abortResume()
    await resuming
    expect(chat.status).toBe('ready')
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({ isAbort: true }))
  })
})
