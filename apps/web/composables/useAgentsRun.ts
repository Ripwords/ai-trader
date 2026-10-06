import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue'
import type { AgentEvent, Rating, RunStatus } from '../types/agents'
import type { SymbolResolution } from '../types/symbol'
import type { RunFrame } from '../server/lib/agents/run-events'

export interface SseMessage { id: string | null; event: string; data: string }

/** Incremental text/event-stream parser; `rest` is the unterminated tail. */
export function parseSse(buffer: string, chunk: string): { messages: SseMessage[]; rest: string } {
  const blocks = (buffer + chunk).split('\n\n')
  const rest = blocks.pop() ?? ''
  const messages: SseMessage[] = []
  for (const block of blocks) {
    let id: string | null = null
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      const colon = line.indexOf(':')
      if (colon === 0) continue
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'id') id = value
      else if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length > 0) messages.push({ id, event, data: data.join('\n') })
  }
  return { messages, rest }
}

interface VerdictState {
  rating: Rating
  confidence: number | null
  rationale: string
}

export interface RunView {
  status: RunStatus | 'idle'
  events: AgentEvent[]
  lastSeq: number
  currentNode: string | null
  verdict: VerdictState | null
  error: string | null
}

export const EMPTY_VIEW: RunView = {
  status: 'idle', events: [], lastSeq: -1, currentNode: null, verdict: null, error: null,
}

/** The run's view is a fold over its frames. Replays after a reconnect
 *  overlap what was already seen, so frames at or below lastSeq are dropped. */
export function applyFrame(view: RunView, frame: RunFrame): RunView {
  if (frame.kind === 'end') {
    return { ...view, status: frame.status, error: frame.status === 'complete' ? null : (frame.error ?? view.error) }
  }
  if (frame.seq <= view.lastSeq) return view
  const ev = frame.event
  const next: RunView = { ...view, events: [...view.events, ev], lastSeq: frame.seq }
  if (ev.type === 'node-start') next.currentNode = ev.node
  else if (ev.type === 'decision') next.verdict = { rating: ev.rating, confidence: ev.confidence, rationale: ev.rationale }
  else if (ev.type === 'error') next.error = ev.message
  return next
}

interface StartOpts {
  max_debate_rounds?: number
  max_risk_discuss_rounds?: number
  deep_thinking?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  response_language?: 'en-US' | 'zh-TW' | 'zh-CN' | 'ja-JP' | 'ko-KR' | 'de-DE'
  selected_analysts?: string[]
}

/** Transport to the run's event stream, independent of the run's own status. */
export type Connection = 'idle' | 'open' | 'reconnecting' | 'lost'

type ReadOutcome = 'ended' | 'not-found' | 'dropped' | 'aborted'

const MAX_RECONNECTS = 6
// Three missed server pings (PING_MS in agent-events.get.ts).
const DEFAULT_IDLE_MS = 45_000
const defaultBackoff = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 15_000)

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export function useAgentsRun(opts: { backoffMs?: (attempt: number) => number; idleMs?: number } = {}) {
  const backoffMs = opts.backoffMs ?? defaultBackoff
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS
  const view = shallowRef<RunView>(EMPTY_VIEW)
  const runId = ref<string | null>(null)
  const connection = ref<Connection>('idle')
  // Set when the symbol could not be uniquely resolved (422), so the page can
  // offer a picker instead of a bare failure.
  const resolution = ref<SymbolResolution | null>(null)
  // agent_runs.started_at, so a refreshed page shows cumulative elapsed time.
  const startedAt = ref<Date | null>(null)
  // A resume request is in flight; the page disables its button meanwhile.
  const resuming = ref(false)
  let controller: AbortController | null = null

  function fail(message: string) {
    view.value = { ...EMPTY_VIEW, status: 'failed', error: message }
  }

  async function readStream(id: string, signal: AbortSignal): Promise<{ outcome: ReadOutcome; progressed: boolean }> {
    // A socket can stay open yet deliver nothing (proxy stall, sleeping
    // laptop). The server pings every 15 s, so silence past idleMs means the
    // connection is dead even though no error surfaced.
    const conn = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = () => {
      conn.abort()
      void reader?.cancel().catch(() => {})
    }
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(stop, idleMs)
    }
    signal.addEventListener('abort', stop, { once: true })
    let progressed = false
    const settle = (outcome: ReadOutcome) => ({ outcome: signal.aborted ? 'aborted' as const : outcome, progressed })
    try {
      arm()
      const res = await fetch(
        `/api/research/agent-events?run_id=${encodeURIComponent(id)}&after=${view.value.lastSeq}`,
        { signal: conn.signal, headers: { accept: 'text/event-stream' } },
      )
      if (res.status === 404) return settle('not-found')
      if (!res.ok || !res.body) return settle('dropped')
      connection.value = 'open'
      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) return settle('dropped')
        arm()
        const { messages, rest } = parseSse(buf, decoder.decode(value, { stream: true }))
        buf = rest
        let v = view.value
        for (const m of messages) {
          if (m.event === 'run') {
            const { startedAt: at } = JSON.parse(m.data) as { startedAt: string | null }
            startedAt.value = at ? new Date(at) : null
            continue
          }
          progressed = true
          if (m.event === 'message' && m.id !== null) {
            v = applyFrame(v, { kind: 'event', seq: Number(m.id), event: JSON.parse(m.data) as AgentEvent })
          }
          else if (m.event === 'end') {
            const end = JSON.parse(m.data) as { status: Exclude<RunStatus, 'running'>; error: string | null }
            view.value = applyFrame(v, { kind: 'end', ...end })
            return settle('ended')
          }
        }
        view.value = v
      }
    }
    catch {
      return settle('dropped')
    }
    finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    }
  }

  async function subscribe(id: string, signal: AbortSignal) {
    let failures = 0
    while (!signal.aborted) {
      const { outcome, progressed } = await readStream(id, signal)
      if (outcome === 'not-found') {
        reset()
        return
      }
      if (outcome !== 'dropped') break
      // Only a connection that delivered something proves the link works; one
      // that opens and closes empty keeps backing off.
      failures = progressed ? 1 : failures + 1
      if (failures > MAX_RECONNECTS) {
        connection.value = 'lost'
        return
      }
      connection.value = 'reconnecting'
      await sleep(backoffMs(failures), signal)
    }
    if (!signal.aborted) connection.value = 'idle'
  }

  /** Show a run: replay its persisted events, then follow it live. */
  async function follow(id: string, opts: { keep?: boolean } = {}) {
    controller?.abort()
    const ac = new AbortController()
    controller = ac
    runId.value = id
    if (!opts.keep) {
      view.value = { ...EMPTY_VIEW, status: 'running' }
      startedAt.value = null
    }
    await subscribe(id, ac.signal)
  }

  /** Pick a lost connection back up from the last seen event. */
  function reconnect() {
    if (!runId.value) return Promise.resolve()
    return follow(runId.value, { keep: true })
  }

  async function start(symbol: string, opts: StartOpts = {}) {
    if (view.value.status === 'running') return
    controller?.abort()
    runId.value = null
    resolution.value = null
    view.value = { ...EMPTY_VIEW, status: 'running' }
    startedAt.value = new Date()

    const res = await fetch('/api/research/agents-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol, ...opts }),
    }).catch(() => null)
    if (!res) return fail('could not reach the server')

    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { data?: { run_id?: string } }
      const existing = body.data?.run_id
      return existing ? follow(existing) : fail('a run is already in progress')
    }
    if (res.status === 422) {
      const body = await res.json().catch(() => ({})) as { data?: SymbolResolution }
      resolution.value = body.data ?? null
      return fail('pick the right instrument from search — this symbol is ambiguous or unknown')
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { statusMessage?: string }
      return fail(body.statusMessage ?? `the run could not start (${res.status})`)
    }

    const { runId: id } = await res.json() as { runId: string }
    await follow(id, { keep: true })
  }

  /** Continue a halted run from its last checkpoint, keeping its timeline. */
  async function resume(id: string) {
    if (view.value.status === 'running' || resuming.value) return
    resuming.value = true
    const res = await fetch('/api/research/agents-resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: id }),
    }).catch(() => null).finally(() => { resuming.value = false })
    if (!res?.ok) {
      view.value = { ...view.value, status: 'failed', error: `resume failed (${res?.status ?? 'network'})` }
      return
    }
    view.value = { ...view.value, status: 'running', error: null }
    await follow(id, { keep: true })
  }

  /** Ask the api to stop the run; the stream's end frame reports the outcome. */
  function cancel() {
    if (!runId.value) return
    void fetch(`/api/research/agents-run?run_id=${encodeURIComponent(runId.value)}`, { method: 'DELETE' })
      .catch(() => null)
  }

  /** Back to the idle page without touching the run itself. */
  function reset() {
    controller?.abort()
    controller = null
    view.value = EMPTY_VIEW
    runId.value = null
    connection.value = 'idle'
    resolution.value = null
    startedAt.value = null
  }

  if (getCurrentScope()) onScopeDispose(() => controller?.abort())

  return {
    events: computed(() => view.value.events),
    status: computed(() => view.value.status),
    currentNode: computed(() => view.value.currentNode),
    verdict: computed(() => view.value.verdict),
    error: computed(() => view.value.error),
    runId, resolution, startedAt, connection, resuming,
    start, resume, cancel, follow, reconnect, reset,
  }
}
