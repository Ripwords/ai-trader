import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../server/llm/http'
import { makeTools } from '../../server/llm/tools'
import { createGuardedTick } from '../../server/lib/guarded-tick'

let server: Server
let baseUrl: string

beforeAll(async () => {
  // Accepts the request and never answers, like an api stuck on OpenD.
  server = createServer(() => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('ApiClient timeout', () => {
  it('rejects instead of hanging when the api never answers', async () => {
    const client = new ApiClient({ baseUrl, bearer: 't', timeoutMs: 100 })
    const started = Date.now()
    await expect(client.getSnapshot({ code: 'US.NVDA' })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('chat tool self-fetches carry a timeout signal', () => {
  type Exec = (args: Record<string, unknown>, ctx: unknown) => unknown
  type ToolMap = Record<string, { execute: Exec }>

  async function signalFor(name: string, args: Record<string, unknown>): Promise<unknown> {
    const fetchSpy = vi.fn(async () => Response.json({ runId: 'r', status: 'running', symbol: 'NVDA' }))
    vi.stubGlobal('fetch', fetchSpy)
    try {
      const tools = makeTools(new ApiClient({ baseUrl, bearer: 't' })) as unknown as ToolMap
      const out = tools[name]!.execute(args, { abortSignal: undefined })
      if (out && typeof (out as AsyncGenerator).next === 'function') {
        await (out as AsyncGenerator).next()
        await (out as AsyncGenerator).next().catch(() => undefined)
      } else {
        await Promise.resolve(out).catch(() => undefined)
      }
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined
      return init?.signal
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it.each([
    ['value_stock', { symbol: 'NVDA' }],
    ['research_start', { symbol: 'NVDA' }],
    ['research_status', { runId: 'r' }],
    ['agents_debate', { symbol: 'NVDA', max_debate_rounds: 1, deep_thinking: false }],
  ])('%s', async (name, args) => {
    expect(await signalFor(name, args)).toBeInstanceOf(AbortSignal)
  })
})

describe('createGuardedTick', () => {
  it('skips overlapping runs', async () => {
    let release: () => void = () => {}
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const tick = createGuardedTick(run, 1_000)
    void tick()
    void tick()
    expect(run).toHaveBeenCalledTimes(1)
    release()
    await Promise.resolve()
    await Promise.resolve()
    void tick()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('frees the busy flag after the deadline when a run never settles', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn(() => new Promise<void>(() => {}))
      const onTimeout = vi.fn()
      const tick = createGuardedTick(run, 1_000, onTimeout)
      void tick()
      void tick()
      expect(run).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_001)
      expect(onTimeout).toHaveBeenCalledTimes(1)
      void tick()
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
