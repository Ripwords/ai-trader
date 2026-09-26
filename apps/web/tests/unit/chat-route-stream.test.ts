import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'

const repo = vi.hoisted(() => ({
  appendMessages: vi.fn(async () => {}),
  createThread: vi.fn(async () => 'th-new'),
  getThread: vi.fn(async (_u: string, id: string) => (id === 'th-1' ? { id } : null)),
  lastMessageId: vi.fn(async (_thread: string): Promise<string | null> => null),
}))

/** The model's token stream, fed by the test. */
let feeder: ReadableStreamDefaultController<LanguageModelV3StreamPart> | undefined
const feed = { enqueue: (p: LanguageModelV3StreamPart) => feeder!.enqueue(p), close: () => feeder!.close() }
let lastModel: MockLanguageModelV3 | undefined
/** When set, the provider call itself fails, before any chunk. */
let providerFailure: Error | null = null
function makeModel() {
  return lastModel = new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => {
      if (providerFailure) throw providerFailure
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(c) {
          feeder = c
          c.enqueue({ type: 'stream-start', warnings: [] })
          c.enqueue({ type: 'text-start', id: 'x' })
          abortSignal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
        },
      })
      return { stream }
    },
  })
}
function finish(unified: 'stop' | 'length' = 'stop') {
  feed.enqueue({ type: 'text-end', id: 'x' })
  feed.enqueue({
    type: 'finish',
    finishReason: { unified, raw: unified },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 2, text: 2, reasoning: 0 },
    },
  })
  feed.close()
}

vi.mock('../../server/db/repo', () => ({
  getOwnerId: async () => 'user-1',
  titleFromText: (t: string) => t,
  ...repo,
}))
const deps = vi.hoisted(() => ({
  listWatchlist: async (): Promise<unknown[]> => [],
  getGhostfolioTools: async (): Promise<Record<string, unknown>> => ({}),
  getGhostfolioStatus: async (): Promise<string> => 'ok',
  buildSystemPrompt: (status: string, _recall: string) => `sys:${status}`,
  makeTools: (): Record<string, unknown> => ({}),
}))
vi.mock('../../server/llm/http', () => ({ getApiClient: () => ({ listWatchlist: () => deps.listWatchlist() }) }))
vi.mock('../../server/llm/mcp', () => ({
  getGhostfolioTools: () => deps.getGhostfolioTools(),
  getGhostfolioStatus: () => deps.getGhostfolioStatus(),
}))
vi.mock('../../server/llm/chat-context', () => ({ buildSystemPrompt: (s: string, r: string) => deps.buildSystemPrompt(s, r) }))
vi.mock('../../server/llm/tools', () => ({ makeTools: () => deps.makeTools() }))
vi.mock('../../server/llm/recall', () => ({ buildRecallContext: async () => '' }))
vi.mock('../../server/lib/llm-cost', () => ({ recordUsageSafely: vi.fn(async () => {}) }))
vi.mock('../../server/llm/model', () => ({
  resolveModel: async () => ({ model: makeModel(), spec: 'mock/model', providerKind: 'openai', modelId: 'model' }),
  supportsForcedToolChoice: () => false,
}))
vi.mock('h3', async (orig) => {
  const actual = await orig<typeof import('h3')>()
  return {
    ...actual,
    readBody: (e: { _body: unknown }) => Promise.resolve(e._body),
    getRouterParam: (e: { _params: Record<string, string> }, k: string) => e._params[k],
  }
})

const { chatStreams } = await import('../../server/lib/chat-streams')
const post = (await import('../../server/api/chat.post')).default as (e: H3Event) => Promise<Response>
const resume = (await import('../../server/api/chat/[id]/stream.get')).default as (e: H3Event) => Promise<Response | null>
const stop = (await import('../../server/api/chat/[id]/stop.post')).default as (e: H3Event) => Promise<unknown>
const stopSend = (await import('../../server/api/chat/stop.post')).default as (e: H3Event) => Promise<unknown>

const event = (body: unknown, params: Record<string, string> = {}) =>
  ({ _body: body, _params: params, context: {}, node: { req: {}, res: {} } }) as unknown as H3Event

const userMessage = (text: string) => ({ id: 'u1', role: 'user', parts: [{ type: 'text', text }] })

async function until(pred: () => boolean) {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise(r => setTimeout(r, 5))
  if (!pred()) throw new Error('condition never held')
}

function assistantSaves() {
  return (repo.appendMessages.mock.calls as unknown as Array<[string, Array<{ role: string; parts: unknown[]; metadata?: unknown }>]>)
    .flatMap(([thread, msgs]) => msgs.filter(m => m.role === 'assistant').map(m => ({ thread, ...m })))
}

beforeEach(() => {
  repo.appendMessages.mockClear()
  repo.createThread.mockClear()
  feeder = undefined
})

afterEach(async () => {
  const left = chatStreams.stop('th-1')
  if (left) await left.done
})

describe('POST /api/chat', () => {
  it('names the thread in the headers and streams the reply as SSE', async () => {
    const res = await post(event({ messages: [userMessage('hi')] }))
    expect(res.headers.get('X-Chat-Id')).toBe('th-new')
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')

    await until(() => chatStreams.isActive('th-new') && feeder !== undefined)
    feed.enqueue({ type: 'text-delta', id: 'x', delta: 'Hello' })
    finish()

    const body = await res.text()
    expect(body).toContain('"delta":"Hello"')
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(assistantSaves()).toHaveLength(1)
  })

  it('saves a reply that ended on an error with the error on it', async () => {
    const res = await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
    await until(() => feeder !== undefined)
    feed.enqueue({ type: 'text-delta', id: 'x', delta: 'half' })
    feed.enqueue({ type: 'error', error: new Error('context window exceeded') })
    feed.close()

    expect(await res.text()).toContain('The assistant stopped early: context window exceeded')
    const [saved] = assistantSaves()
    expect(saved?.metadata).toMatchObject({ error: 'The assistant stopped early: context window exceeded' })
  })

  it('marks a reply that ended with no answer, live and when saved', async () => {
    const res = await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
    await until(() => feeder !== undefined)
    finish()

    expect(await res.text()).toContain('"messageMetadata":{"error":"The model returned no answer."}')
    const [saved] = assistantSaves()
    expect(saved?.metadata).toMatchObject({ error: 'The model returned no answer.' })
  })

  it('marks a reply cut off at the output limit', async () => {
    await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
    await until(() => feeder !== undefined)
    feed.enqueue({ type: 'text-delta', id: 'x', delta: 'half an ans' })
    finish('length')
    await until(() => !chatStreams.isActive('th-1'))

    const [saved] = assistantSaves()
    expect(saved?.metadata).toMatchObject({ error: expect.stringMatching(/output limit/) })
  })

  it('saves a reply that failed before its first chunk, carrying the error', async () => {
    providerFailure = new Error('401 invalid api key')
    try {
      const res = await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
      expect(await res.text()).toContain('The assistant stopped early: 401 invalid api key')
      await until(() => !chatStreams.isActive('th-1'))

      const [saved] = assistantSaves()
      expect(saved?.thread).toBe('th-1')
      expect(saved?.metadata).toMatchObject({ error: 'The assistant stopped early: 401 invalid api key' })
    } finally {
      providerFailure = null
    }
  })

  it('keeps generating and saves the reply after the client disconnects', async () => {
    const res = await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
    await until(() => chatStreams.isActive('th-1') && feeder !== undefined)
    await res.body!.cancel()

    feed.enqueue({ type: 'text-delta', id: 'x', delta: 'still here' })
    finish()

    await until(() => !chatStreams.isActive('th-1'))
    const [saved] = assistantSaves()
    expect(saved?.thread).toBe('th-1')
    expect(JSON.stringify(saved?.parts)).toContain('still here')
  })

  it('refuses a second message while the thread is still replying', async () => {
    await post(event({ messages: [userMessage('one')], chatId: 'th-1' }))
    await until(() => chatStreams.isActive('th-1') && feeder !== undefined)

    await expect(post(event({ messages: [userMessage('two')], chatId: 'th-1' }))).rejects.toMatchObject({ statusCode: 409, data: { code: 'chat_busy' } })
    expect(repo.appendMessages).toHaveBeenCalledTimes(1)

    finish()
    await until(() => !chatStreams.isActive('th-1'))
  })
})

describe('POST /api/chat concurrent sends', () => {
  it('refuses the second of two near-simultaneous sends before saving its question', async () => {
    let release!: () => void
    repo.lastMessageId.mockImplementationOnce(() => new Promise(r => { release = () => r(null) }))
    const first = post(event({ messages: [userMessage('one')], chatId: 'th-1' }))
    const second = post(event({ messages: [{ ...userMessage('two'), id: 'u2' }], chatId: 'th-1' }))

    await expect(second).rejects.toMatchObject({ statusCode: 409, data: { code: 'chat_busy' } })
    await until(() => release !== undefined)
    release()
    await first
    await until(() => feeder !== undefined)
    finish()
    await until(() => !chatStreams.isActive('th-1'))

    const questions = (repo.appendMessages.mock.calls as unknown as Array<[string, Array<{ id: string; role: string }>]>)
      .flatMap(([, msgs]) => msgs.filter(m => m.role === 'user').map(m => m.id))
    expect(questions).toEqual(['u1'])
  })
})

describe('POST /api/chat retry', () => {
  it('does not save the question again when retrying its reply', async () => {
    repo.lastMessageId.mockResolvedValueOnce('u1')
    await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
    await until(() => feeder !== undefined)
    finish()
    await until(() => !chatStreams.isActive('th-1'))

    const roles = (repo.appendMessages.mock.calls as unknown as Array<[string, Array<{ role: string }>]>)
      .flatMap(([, msgs]) => msgs.map(m => m.role))
    expect(roles).toEqual(['assistant'])
  })
})

describe('POST /api/chat pre-flight', () => {
  afterEach(() => {
    vi.useRealTimers()
    deps.listWatchlist = async () => []
    deps.getGhostfolioTools = async () => ({})
    deps.getGhostfolioStatus = async () => 'ok'
  })

  it('sends the first bytes at once and starts without a hung MCP or watchlist', async () => {
    vi.useFakeTimers()
    const hang = () => new Promise<never>(() => {})
    deps.getGhostfolioTools = hang
    deps.getGhostfolioStatus = hang
    deps.listWatchlist = hang
    const prompts: string[] = []
    const realPrompt = deps.buildSystemPrompt
    deps.buildSystemPrompt = (status, recall) => {
      prompts.push(status)
      return realPrompt(status, recall)
    }

    const res = await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe(': connected\n\n')

    await vi.advanceTimersByTimeAsync(2_900)
    expect(feeder).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(feeder).toBeDefined()
    expect(prompts).toEqual(['failing'])

    deps.buildSystemPrompt = realPrompt
    finish()
    await reader.cancel()
  })
})

describe('GET /api/chat/:id/stream', () => {
  it('answers 204 when no reply is in progress', async () => {
    const res = await resume(event(undefined, { id: 'th-1' }))
    expect(res).toBeInstanceOf(Response)
    expect(res!.status).toBe(204)
  })

  it('replays the reply so far and follows it to the end', async () => {
    await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
    await until(() => chatStreams.isActive('th-1') && feeder !== undefined)
    feed.enqueue({ type: 'text-delta', id: 'x', delta: 'early ' })
    await new Promise(r => setTimeout(r, 10))

    const res = await resume(event(undefined, { id: 'th-1' }))
    feed.enqueue({ type: 'text-delta', id: 'x', delta: 'late' })
    finish()

    const body = await res!.text()
    expect(body).toContain('"delta":"early "')
    expect(body).toContain('"delta":"late"')
    expect(body).toContain('"type":"finish"')
  })
})

describe('POST /api/chat/:id/stop', () => {
  it('aborts the generation and saves the partial reply marked stopped', async () => {
    await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
    await until(() => chatStreams.isActive('th-1') && feeder !== undefined)
    feed.enqueue({ type: 'text-delta', id: 'x', delta: 'partial' })
    await new Promise(r => setTimeout(r, 10))

    expect(await stop(event(undefined, { id: 'th-1' }))).toEqual({ stopped: true })
    await until(() => !chatStreams.isActive('th-1'))

    const [saved] = assistantSaves()
    expect(JSON.stringify(saved?.parts)).toContain('partial')
    expect(saved?.metadata).toMatchObject({ stopped: true })
  })

  it('stops a reply stuck in a tool call and saves the call as ended', async () => {
    deps.makeTools = () => ({
      slow: tool({ inputSchema: z.object({}), execute: () => new Promise<never>(() => {}) }),
    })
    try {
      await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
      await until(() => feeder !== undefined)
      feed.enqueue({ type: 'text-end', id: 'x' })
      feed.enqueue({ type: 'tool-call', toolCallId: 'c1', toolName: 'slow', input: '{}' })
      feed.enqueue({
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      })
      feed.close()
      await new Promise(r => setTimeout(r, 20))

      expect(await stop(event(undefined, { id: 'th-1' }))).toEqual({ stopped: true })
      expect(chatStreams.isActive('th-1')).toBe(false)

      const [saved] = assistantSaves()
      expect(saved?.metadata).toMatchObject({ stopped: true })
      const call = saved?.parts.find(p => (p as { type: string }).type === 'tool-slow') as { state: string } | undefined
      expect(call?.state).toBe('output-error')
    } finally {
      deps.makeTools = () => ({})
    }
  })

  it('leaves out tool calls that never finished when sending the history on', async () => {
    const stoppedReply = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'tool-slow', toolCallId: 'c1', state: 'input-available', input: {} }],
    }
    await post(event({ messages: [userMessage('hi'), stoppedReply, userMessage('again')], chatId: 'th-1' }))
    await until(() => feeder !== undefined)
    finish()
    await until(() => !chatStreams.isActive('th-1'))

    const prompt = JSON.stringify(lastModel!.doStreamCalls[0]!.prompt)
    expect(prompt).not.toContain('tool-call')
  })

  it('clears its settle timer once the stopped reply is saved', async () => {
    await post(event({ messages: [userMessage('hi')], chatId: 'th-1' }))
    await until(() => chatStreams.isActive('th-1') && feeder !== undefined)
    const set = vi.spyOn(globalThis, 'setTimeout')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    try {
      expect(await stop(event(undefined, { id: 'th-1' }))).toEqual({ stopped: true })
      const settle = set.mock.calls.findIndex(([, ms]) => ms === 5_000)
      expect(settle).toBeGreaterThanOrEqual(0)
      expect(clear).toHaveBeenCalledWith(set.mock.results[settle]!.value)
    } finally {
      set.mockRestore()
      clear.mockRestore()
    }
  })

  it('reports nothing to stop when idle', async () => {
    expect(await stop(event(undefined, { id: 'th-1' }))).toEqual({ stopped: false })
  })
})

describe('POST /api/chat/stop', () => {
  it('stops a send that has not reached the model yet, and names its new thread', async () => {
    const stopping = stopSend(event({ requestId: 'req-1' }))
    await post(event({ messages: [userMessage('hi')], requestId: 'req-1' }))

    expect(await stopping).toEqual({ stopped: true, threadId: 'th-new' })
    expect(chatStreams.isActive('th-new')).toBe(false)
    expect(feeder).toBeUndefined()
    const [saved] = assistantSaves()
    expect(saved).toMatchObject({ thread: 'th-new', metadata: { stopped: true } })
    const questions = (repo.appendMessages.mock.calls as unknown as Array<[string, Array<{ role: string }>]>)
      .flatMap(([, msgs]) => msgs.filter(m => m.role === 'user'))
    expect(questions).toHaveLength(1)
  })

  it('stops a send that is already generating', async () => {
    await post(event({ messages: [userMessage('hi')], chatId: 'th-1', requestId: 'req-2' }))
    await until(() => chatStreams.isActive('th-1') && feeder !== undefined)

    expect(await stopSend(event({ requestId: 'req-2' }))).toEqual({ stopped: true, threadId: 'th-1' })
    expect(chatStreams.isActive('th-1')).toBe(false)
  })

  it('rejects a missing request id', async () => {
    await expect(stopSend(event({}))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('gives up on a send that never arrives', async () => {
    vi.useFakeTimers()
    try {
      const stopping = stopSend(event({ requestId: 'req-lost' }))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await stopping).toEqual({ stopped: false })
    } finally {
      vi.useRealTimers()
    }
  })
})
