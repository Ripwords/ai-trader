import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessageChunk } from 'ai'
import { ChatStreamBusyError, ChatStreamRegistry, chatSseResponse } from '../../server/lib/chat-streams'

const text = (delta: string): UIMessageChunk => ({ type: 'text-delta', id: 't', delta })

/** A producer the test drives by hand: push chunks, then end it. */
function manualSource() {
  let ctrl!: ReadableStreamDefaultController<UIMessageChunk>
  let signal!: AbortSignal
  const stream = new ReadableStream<UIMessageChunk>({ start(c) { ctrl = c } })
  return {
    produce: (s: AbortSignal) => {
      signal = s
      s.addEventListener('abort', () => {
        ctrl.enqueue({ type: 'abort' })
        ctrl.close()
      })
      return stream
    },
    push: (c: UIMessageChunk) => ctrl.enqueue(c),
    end: () => ctrl.close(),
    get signal() { return signal },
  }
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('ChatStreamRegistry', () => {
  it('replays every chunk to a late subscriber, then tails the rest', async () => {
    const reg = new ChatStreamRegistry()
    const src = manualSource()
    const entry = reg.start('th-1', src.produce)
    src.push({ type: 'start' })
    src.push(text('Hel'))
    await tick()

    const late = readAll(reg.subscribe('th-1')!)
    src.push(text('lo'))
    src.push({ type: 'finish' })
    src.end()

    expect(await late).toEqual([{ type: 'start' }, text('Hel'), text('lo'), { type: 'finish' }])
    expect(await entry.done).toBe('done')
  })

  it('gives two concurrent subscribers the same sequence', async () => {
    const reg = new ChatStreamRegistry()
    const src = manualSource()
    reg.start('th-1', src.produce)
    const a = readAll(reg.subscribe('th-1')!)
    src.push(text('a'))
    await tick()
    const b = readAll(reg.subscribe('th-1')!)
    src.push(text('b'))
    await tick()
    src.push(text('c'))
    src.end()

    const [seqA, seqB] = await Promise.all([a, b])
    expect(seqA).toEqual([text('a'), text('b'), text('c')])
    expect(seqB).toEqual(seqA)
  })

  it('stop aborts the producer and ends the stream as aborted', async () => {
    const reg = new ChatStreamRegistry()
    const src = manualSource()
    const entry = reg.start('th-1', src.produce)
    const sub = readAll(reg.subscribe('th-1')!)
    src.push(text('partial'))
    await tick()

    expect(reg.stop('th-1')).toBe(entry)

    expect(src.signal.aborted).toBe(true)
    expect(await entry.done).toBe('aborted')
    expect(await sub).toEqual([text('partial'), { type: 'abort' }])
    expect(reg.subscribe('th-1')).toBeNull()
    expect(reg.stop('th-1')).toBeNull()
  })

  it('keeps generating when every subscriber goes away', async () => {
    const reg = new ChatStreamRegistry()
    const src = manualSource()
    const entry = reg.start('th-1', src.produce)
    const sub = reg.subscribe('th-1')!
    await sub.cancel()
    src.push(text('still'))
    src.end()

    expect(await entry.done).toBe('done')
    expect(entry.chunks).toEqual([text('still')])
  })

  it('refuses a second generation on a thread that is still streaming', () => {
    const reg = new ChatStreamRegistry()
    reg.start('th-1', manualSource().produce)
    expect(() => reg.start('th-1', manualSource().produce)).toThrow(ChatStreamBusyError)
    expect(reg.isActive('th-1')).toBe(true)
  })

  it('ends as error with a visible error chunk when the producer throws', async () => {
    const reg = new ChatStreamRegistry()
    const entry = reg.start('th-1', () => new ReadableStream<UIMessageChunk>({
      pull() { throw new Error('socket hang up') },
    }))

    expect(await entry.done).toBe('error')
    expect(entry.chunks).toEqual([{ type: 'error', errorText: 'socket hang up' }])
    expect(reg.isActive('th-1')).toBe(false)
  })

  it('ends as aborted only when the producer reports the abort', async () => {
    const reg = new ChatStreamRegistry()
    const entry = reg.start('th-1', () => new ReadableStream<UIMessageChunk>({
      start(c) {
        c.enqueue(text('all of it'))
        c.close()
      },
    }))
    reg.stop('th-1')
    expect(await entry.done).toBe('done')
  })

  it('reports an error chunk from the producer as an error ending', async () => {
    const reg = new ChatStreamRegistry()
    const src = manualSource()
    const entry = reg.start('th-1', src.produce)
    src.push({ type: 'error', errorText: 'context window exceeded' })
    src.end()
    expect(await entry.done).toBe('error')
  })
})

describe('chatSseResponse', () => {
  it('frames chunks as SSE, pings while idle, and ends with [DONE]', async () => {
    vi.useFakeTimers()
    let ctrl!: ReadableStreamDefaultController<UIMessageChunk>
    const chunks = new ReadableStream<UIMessageChunk>({ start(c) { ctrl = c } })
    const res = chatSseResponse(chunks, { pingMs: 1000, headers: { 'X-Chat-Id': 'th-1' } })

    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    expect(res.headers.get('X-Chat-Id')).toBe('th-1')

    const body = res.text()
    ctrl.enqueue(text('hi'))
    await vi.advanceTimersByTimeAsync(1000)
    ctrl.close()
    await vi.runAllTimersAsync()

    expect(await body).toBe(
      `: connected\n\ndata: ${JSON.stringify(text('hi'))}\n\n: ping\n\ndata: [DONE]\n\n`,
    )
  })
})
