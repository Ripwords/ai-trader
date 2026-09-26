// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyFrame, EMPTY_VIEW, parseSse, useAgentsRun } from '../../composables/useAgentsRun'
import type { AgentEvent } from '../../types/agents'

const runStart: AgentEvent = { type: 'run-start', run_id: 'r-7', symbol: 'NVDA', config: {} }
const market: AgentEvent = { type: 'node-start', node: 'market' }
const decision: AgentEvent = { type: 'decision', rating: 'buy', confidence: 70, rationale: 'ok' }
const runEnd: AgentEvent = { type: 'run-end', run_id: 'r-7', tokens_in: 1, tokens_out: 1, cost_usd: 0.01 }

function sse(...parts: string[]): string {
  return parts.join('')
}
const msg = (seq: number, ev: AgentEvent) => `id: ${seq}\ndata: ${JSON.stringify(ev)}\n\n`
const end = (status: string, error: string | null = null) => `event: end\ndata: ${JSON.stringify({ status, error })}\n\n`
const runMeta = (startedAt: string) => `event: run\ndata: ${JSON.stringify({ startedAt })}\n\n`

function sseResponse(body: string, opts: { hang?: boolean } = {}): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(body))
      if (!opts.hang) c.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>
function mockFetch(route: Route) {
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => route(String(input), init))
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseSse', () => {
  it('splits complete messages and keeps a partial one buffered', () => {
    const first = parseSse('', 'id: 3\ndata: {"a":1}\n\nevent: ping\ndata: \n\nid: 4\nda')
    expect(first.messages).toEqual([
      { id: '3', event: 'message', data: '{"a":1}' },
      { id: null, event: 'ping', data: '' },
    ])
    const second = parseSse(first.rest, 'ta: {"b":2}\n\n')
    expect(second.messages).toEqual([{ id: '4', event: 'message', data: '{"b":2}' }])
    expect(second.rest).toBe('')
  })
})

describe('applyFrame', () => {
  it('builds the view from events and drops replayed seqs', () => {
    let v = { ...EMPTY_VIEW, status: 'running' as const }
    v = applyFrame(v, { kind: 'event', seq: 0, event: runStart })
    v = applyFrame(v, { kind: 'event', seq: 1, event: market })
    v = applyFrame(v, { kind: 'event', seq: 1, event: market })
    v = applyFrame(v, { kind: 'event', seq: 0, event: runStart })
    v = applyFrame(v, { kind: 'event', seq: 2, event: decision })

    expect(v.events).toEqual([runStart, market, decision])
    expect(v.lastSeq).toBe(2)
    expect(v.currentNode).toBe('market')
    expect(v.verdict).toEqual({ rating: 'buy', confidence: 70, rationale: 'ok' })
    expect(v.status).toBe('running')
  })

  it('takes the terminal status and reason from the end frame', () => {
    const v = applyFrame({ ...EMPTY_VIEW, status: 'running' }, { kind: 'end', status: 'failed', error: 'interrupted by a web server restart' })
    expect(v.status).toBe('failed')
    expect(v.error).toBe('interrupted by a web server restart')
  })
})

describe('useAgentsRun.start', () => {
  it('starts a run and follows its events to the end', async () => {
    const fetchSpy = mockFetch((url) => {
      if (url === '/api/research/agents-run') return Response.json({ runId: 'r-7', status: 'running', symbol: 'NVDA' })
      return sseResponse(sse(runMeta('2026-05-10T12:00:00Z'), msg(0, runStart), msg(1, market), msg(2, decision), msg(3, runEnd), end('complete')))
    })
    const run = useAgentsRun()
    await run.start('NVDA')

    expect(fetchSpy.mock.calls[1]?.[0]).toBe('/api/research/agent-events?run_id=r-7&after=-1')
    expect(run.runId.value).toBe('r-7')
    expect(run.status.value).toBe('complete')
    expect(run.events.value).toHaveLength(4)
    expect(run.verdict.value).toMatchObject({ rating: 'buy' })
    expect(run.startedAt.value?.toISOString()).toBe('2026-05-10T12:00:00.000Z')
    expect(run.connection.value).toBe('idle')
  })

  it('follows the in-flight run when one is already running for the symbol', async () => {
    mockFetch((url) => {
      if (url === '/api/research/agents-run') return Response.json({ data: { run_id: 'existing-7' } }, { status: 409 })
      return sseResponse(sse(msg(0, runStart), end('complete')))
    })
    const run = useAgentsRun()
    await run.start('NVDA')

    expect(run.runId.value).toBe('existing-7')
    expect(run.status.value).toBe('complete')
  })

  it('surfaces ambiguous candidates on 422 without starting', async () => {
    mockFetch(() => Response.json({
      data: {
        status: 'ambiguous',
        candidates: [{ moomoo: 'US.MU', yahoo: 'MU', name: 'Micron Technology, Inc.', exchange: 'NASDAQ', type: 'Equity' }],
      },
    }, { status: 422 }))
    const run = useAgentsRun()
    await run.start('MU')

    expect(run.status.value).toBe('failed')
    expect(run.events.value).toEqual([])
    expect(run.resolution.value).toMatchObject({ status: 'ambiguous' })
    expect(run.error.value?.toLowerCase()).toContain('pick')
  })
})

describe('useAgentsRun.follow', () => {
  it('resets to idle when the run does not exist', async () => {
    mockFetch(() => new Response('', { status: 404 }))
    const run = useAgentsRun()
    await run.follow('missing')

    expect(run.status.value).toBe('idle')
    expect(run.runId.value).toBeNull()
  })

  it('reconnects after a dropped stream from the last seen seq, without duplicates', async () => {
    const urls: string[] = []
    let call = 0
    mockFetch((url) => {
      urls.push(url)
      call++
      if (call === 1) return sseResponse(sse(msg(0, runStart), msg(1, market)))
      return sseResponse(sse(msg(1, market), msg(2, decision), msg(3, runEnd), end('complete')))
    })
    const run = useAgentsRun({ backoffMs: () => 0 })
    await run.follow('r-7')

    expect(urls[1]).toBe('/api/research/agent-events?run_id=r-7&after=1')
    expect(run.events.value).toEqual([runStart, market, decision, runEnd])
    expect(run.status.value).toBe('complete')
  })

  it('drops and reconnects a socket that goes silent past the heartbeat window', async () => {
    const urls: string[] = []
    mockFetch((url) => {
      urls.push(url)
      if (urls.length === 1) return sseResponse(sse(runMeta('2026-05-10T12:00:00Z'), msg(0, runStart)), { hang: true })
      return sseResponse(sse(msg(1, decision), end('complete')))
    })
    const run = useAgentsRun({ backoffMs: () => 0, idleMs: 20 })
    await run.follow('r-7')

    expect(urls).toHaveLength(2)
    expect(urls[1]).toBe('/api/research/agent-events?run_id=r-7&after=0')
    expect(run.status.value).toBe('complete')
  })

  it('keeps backing off when connections open but deliver nothing', async () => {
    const attempts: number[] = []
    let calls = 0
    mockFetch(() => {
      calls++
      if (calls > 10) return sseResponse(sse(end('complete')))
      return sseResponse(runMeta('2026-05-10T12:00:00Z'))
    })
    const run = useAgentsRun({ backoffMs: (n) => { attempts.push(n); return 0 } })
    await run.follow('r-7')

    expect(attempts).toEqual([1, 2, 3, 4, 5, 6])
    expect(run.connection.value).toBe('lost')
  })

  it('resets the backoff once a connection delivers progress', async () => {
    const attempts: number[] = []
    let calls = 0
    mockFetch(() => {
      calls++
      if (calls === 3) return sseResponse(sse(msg(0, runStart)))
      if (calls > 4) return sseResponse(sse(end('complete')))
      return sseResponse('')
    })
    const run = useAgentsRun({ backoffMs: (n) => { attempts.push(n); return 0 } })
    await run.follow('r-7')

    expect(attempts).toEqual([1, 2, 1, 2])
    expect(run.status.value).toBe('complete')
  })

  it('reports a lost connection after repeated failures, and reconnect() picks up from there', async () => {
    let up = false
    mockFetch(() => {
      if (!up) throw new TypeError('network down')
      return sseResponse(sse(msg(0, runStart), end('complete')))
    })
    const run = useAgentsRun({ backoffMs: () => 0 })
    await run.follow('r-7')

    expect(run.connection.value).toBe('lost')
    expect(run.status.value).toBe('running')

    up = true
    await run.reconnect()
    expect(run.connection.value).toBe('idle')
    expect(run.status.value).toBe('complete')
  })
})

describe('useAgentsRun.resume', () => {
  it('keeps the halted timeline and follows the resumed events after it', async () => {
    const urls: string[] = []
    let stage: 'history' | 'resumed' = 'history'
    mockFetch((url) => {
      urls.push(url)
      if (url === '/api/research/agents-resume') {
        stage = 'resumed'
        return Response.json({ runId: 'r-7' })
      }
      if (stage === 'history') {
        return sseResponse(sse(msg(0, runStart), msg(1, { type: 'error', message: 'boom' }), end('failed', 'boom')))
      }
      return sseResponse(sse(msg(2, decision), msg(3, runEnd), end('complete')))
    })
    const run = useAgentsRun()
    await run.follow('r-7')
    expect(run.status.value).toBe('failed')

    await run.resume('r-7')

    expect(urls.at(-1)).toBe('/api/research/agent-events?run_id=r-7&after=1')
    expect(run.status.value).toBe('complete')
    expect(run.error.value).toBeNull()
    expect(run.events.value).toHaveLength(4)
  })

  it('sends one resume request however often it is clicked while pending', async () => {
    let release: (r: Response) => void = () => {}
    const fetchSpy = mockFetch((url) => {
      if (url === '/api/research/agents-resume') return new Promise<Response>((r) => { release = r })
      return sseResponse(sse(msg(2, decision), end('complete')))
    })
    const run = useAgentsRun()

    const first = run.resume('r-7')
    expect(run.resuming.value).toBe(true)
    const second = run.resume('r-7')
    release(Response.json({ runId: 'r-7' }))
    await Promise.all([first, second])

    expect(fetchSpy.mock.calls.filter(c => c[0] === '/api/research/agents-resume')).toHaveLength(1)
    expect(run.resuming.value).toBe(false)
    expect(run.status.value).toBe('complete')
  })
})
