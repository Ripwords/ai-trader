import { getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue'
import type { AgentEvent, Rating } from '../types/agents'
import type { SymbolResolution } from '../types/symbol'

export function parseNdjsonChunk(buffer: string, chunk: string, out: AgentEvent[]): string {
  const combined = buffer + chunk
  const lines = combined.split('\n')
  const last = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as AgentEvent)
    } catch {
      /* ignore malformed */
    }
  }
  return last
}

interface VerdictState {
  rating: Rating
  confidence: number | null
  rationale: string
}

interface StartOpts {
  max_debate_rounds?: number
  max_risk_discuss_rounds?: number
  deep_thinking?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  response_language?: 'en-US' | 'zh-TW' | 'zh-CN' | 'ja-JP' | 'ko-KR' | 'de-DE'
  selected_analysts?: string[]
}

export function useAgentsRun() {
  const events = shallowRef<AgentEvent[]>([])
  const status = ref<'idle' | 'running' | 'complete' | 'failed' | 'cancelled'>('idle')
  const currentNode = ref<string | null>(null)
  const verdict = ref<VerdictState | null>(null)
  const runId = ref<string | null>(null)
  const error = ref<string | null>(null)
  // Set when the proxy rejects an unresolved symbol (422). Carries the
  // resolver verdict so the page can render a "pick the right instrument"
  // picker instead of a cryptic failure. See
  // docs/superpowers/specs/2026-05-18-canonical-ticker-resolution-design.md.
  const resolution = ref<SymbolResolution | null>(null)
  // Real wall-clock start of the run, not the moment the local fetch began.
  // Sourced from agent_runs.started_at when replaying from history so a
  // refreshed page shows the cumulative elapsed time, not a re-zeroed counter.
  const startedAt = ref<Date | null>(null)
  let controller: AbortController | null = null

  /**
   * Drain an NDJSON stream into the reactive state. Shared by ``start`` and
   * ``resume``: the only difference between them is the request shape, so
   * the streaming loop is factored out here to keep the two entry points
   * thin and behaviorally identical (run-start handling, error/run-end
   * status transitions, etc).
   */
  async function consumeStream(res: Response, abortCtrl: AbortController) {
    if (!res.body) {
      status.value = 'failed'
      error.value = 'no body'
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        const next: AgentEvent[] = []
        buf = parseNdjsonChunk(buf, decoder.decode(value, { stream: true }), next)
        if (next.length) {
          events.value = [...events.value, ...next]
          for (const ev of next) {
            if (ev.type === 'run-start') runId.value = ev.run_id
            else if (ev.type === 'node-start') currentNode.value = ev.node
            else if (ev.type === 'decision') {
              verdict.value = { rating: ev.rating, confidence: ev.confidence, rationale: ev.rationale }
            }
            else if (ev.type === 'error') {
              error.value = ev.message
              status.value = 'failed'
            }
            else if (ev.type === 'run-end' && status.value === 'running') status.value = 'complete'
          }
        }
      }
    } catch (e: unknown) {
      if (abortCtrl.signal.aborted) status.value = 'cancelled'
      else {
        status.value = 'failed'
        error.value = (e as Error)?.message ?? 'stream error'
      }
    }
  }

  async function start(symbol: string, opts: StartOpts = {}) {
    if (status.value === 'running') return
    events.value = []
    status.value = 'running'
    currentNode.value = null
    verdict.value = null
    error.value = null
    startedAt.value = new Date()
    controller = new AbortController()

    const res = await fetch('/api/research/agents-run', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol, ...opts }),
    })

    // 409 = a run is already in-flight for this (user, symbol). The route
    // includes ``data: { run_id }`` so we surface the existing run id; UI
    // can offer a "Jump to in-flight run" link instead of starting another.
    if (res.status === 409) {
      let existingRunId: string | null = null
      try {
        const body = (await res.json()) as { data?: { run_id?: string } }
        existingRunId = body?.data?.run_id ?? null
      } catch {
        /* fall through to plain failed state */
      }
      runId.value = existingRunId
      status.value = 'failed'
      error.value = existingRunId
        ? `a run is already in progress (run_id ${existingRunId})`
        : 'a run is already in progress'
      return
    }

    // 422 = the symbol could not be uniquely resolved to a canonical Yahoo
    // listing. The proxy refuses to start the run (the "US.MU" → "Munich Re"
    // bug); surface the resolver verdict so the page can show a picker.
    if (res.status === 422) {
      try {
        const body = (await res.json()) as { data?: SymbolResolution }
        resolution.value = body?.data ?? null
      } catch {
        resolution.value = null
      }
      status.value = 'failed'
      error.value = 'pick the right instrument from search — this symbol is ambiguous or unknown'
      return
    }

    await consumeStream(res, controller)
  }

  /**
   * Resume a previously-failed run. Reuses the same ``run_id`` upstream so
   * all replayed events tee back into the original ``agent_runs`` row. Note
   * we don't reset ``runId`` here — Resume keeps the existing id; we just
   * clear the visible event list so the timeline starts fresh from the
   * checkpoint.
   */
  async function resume(originalRunId: string) {
    if (status.value === 'running') return
    events.value = []
    status.value = 'running'
    currentNode.value = null
    verdict.value = null
    error.value = null
    runId.value = originalRunId
    // ``startedAt`` from the original run is more meaningful than "now" here,
    // but we don't have it on the resume path. The page-level elapsed counter
    // will reflect the resume window only — fine for v1; full cumulative
    // time would need fetching the agent_runs row first.
    startedAt.value = new Date()
    controller = new AbortController()

    const res = await fetch('/api/research/agents-resume', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: originalRunId }),
    })
    await consumeStream(res, controller)
  }

  /**
   * Cancel an in-flight run.
   *
   * Two-step: aborting the local fetch closes the HTTP connection so the
   * browser stops receiving events, but the *upstream task* on the api side
   * keeps running until LangGraph notices the disconnect (which it may not,
   * especially during a long LLM call). Calling DELETE
   * /api/research/agents-run?run_id=<id> proxies through to the api's
   * ``_active_runs`` registry which calls ``task.cancel()`` on the asyncio
   * task — that's the actual stop signal.
   */
  /**
   * Drop all reactive state back to the idle baseline without touching
   * the upstream run. Used by the page when the user clicks the symbol
   * breadcrumb to exit a ?run=<id> deep-link — we want the page to
   * render the RunCostEstimate again as if no run had been loaded.
   * ``cancel()`` is the wrong tool there because we don't want to fire
   * a DELETE on a finished historical run.
   */
  function reset() {
    if (controller) {
      controller.abort()
      controller = null
    }
    stopPoll()
    events.value = []
    status.value = 'idle'
    currentNode.value = null
    verdict.value = null
    runId.value = null
    error.value = null
    startedAt.value = null
  }

  function cancel() {
    const idToCancel = runId.value
    controller?.abort()
    stopPoll()
    if (idToCancel) {
      void fetch(`/api/research/agents-run?run_id=${encodeURIComponent(idToCancel)}`, {
        method: 'DELETE',
      }).catch(() => null)
    }
    if (status.value === 'running') status.value = 'cancelled'
  }

  /**
   * Apply a batch of replayed events to reactive state. Identical semantics
   * to the live ``consumeStream`` event handler so a run rehydrated from
   * ``agent_messages`` after a refresh ends up in the same final state as
   * one watched live.
   */
  function applyEvents(batch: AgentEvent[]) {
    if (batch.length === 0) return
    events.value = [...events.value, ...batch]
    for (const ev of batch) {
      if (ev.type === 'run-start') runId.value = ev.run_id
      else if (ev.type === 'node-start') currentNode.value = ev.node
      else if (ev.type === 'decision') {
        verdict.value = { rating: ev.rating, confidence: ev.confidence, rationale: ev.rationale }
      }
      else if (ev.type === 'error') {
        error.value = ev.message
      }
    }
  }

  // ────── Refresh-survival: replay from ``agent_messages`` ──────
  // The tee on the proxy route writes every event into ``agent_messages``
  // keyed by (run_id, seq). Here we read those rows back so a page reload
  // (or opening ``?run=<id>`` in a new tab) reconstructs the same timeline
  // the live stream produced. If the server-side run is still ``running``,
  // we additionally start a 2s poll loop that pulls new events keyed by
  // last-seen seq — a pragmatic stand-in for reconnecting the original
  // SSE/NDJSON stream from a different browser context, which HTTP doesn't
  // allow.
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let lastSeq = -1

  function stopPoll() {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }
  // Leaving /research/AAPL for /research/TSLA used to keep the old 2s poll
  // alive forever next to the new one.
  if (getCurrentScope()) onScopeDispose(stopPoll)

  interface MessagesResponse {
    runId: string
    status: 'running' | 'complete' | 'failed' | 'cancelled'
    startedAt: string | null
    finishedAt: string | null
    lastSeq: number
    events: AgentEvent[]
  }

  async function fetchMessages(targetRunId: string, since: number): Promise<MessagesResponse | 'not-found' | null> {
    try {
      const res = await fetch(`/api/research/agent-messages?run_id=${encodeURIComponent(targetRunId)}&since=${since}`, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
      })
      if (res.status === 404) return 'not-found'
      if (!res.ok) return null
      return (await res.json()) as MessagesResponse
    }
    catch {
      return null
    }
  }

  /**
   * Hydrate the composable from a run's persisted event log. Replaces any
   * existing local state — callers should ensure they're not overwriting
   * an in-flight live stream.
   *
   * If the server-side run is still ``running``, automatically starts a
   * background poll for incremental updates; the poll stops when the run's
   * status transitions out of ``running``.
   */
  async function loadFromHistory(targetRunId: string) {
    stopPoll()
    if (controller) controller.abort()
    events.value = []
    status.value = 'running'
    currentNode.value = null
    verdict.value = null
    error.value = null
    runId.value = targetRunId
    lastSeq = -1

    const initial = await fetchMessages(targetRunId, -1)
    if (initial === 'not-found') {
      // Stale URL pointing at a deleted/never-persisted run. Reset to idle so
      // the page renders the Run button instead of a confusing error banner.
      status.value = 'idle'
      runId.value = null
      startedAt.value = null
      return
    }
    if (initial === null) {
      status.value = 'failed'
      error.value = 'failed to load run history'
      return
    }
    applyEvents(initial.events)
    lastSeq = initial.lastSeq
    status.value = initial.status
    startedAt.value = initial.startedAt ? new Date(initial.startedAt) : null

    if (initial.status === 'running') {
      pollTimer = setInterval(() => {
        void (async () => {
          const next = await fetchMessages(targetRunId, lastSeq)
          if (next === null || next === 'not-found') return
          applyEvents(next.events)
          lastSeq = next.lastSeq
          // The server's truth wins — once it flips out of ``running`` we
          // mirror that and stop polling. Note ``run-end`` may arrive in the
          // event batch too, but ``status`` from the run row is authoritative.
          if (next.status !== 'running') {
            status.value = next.status
            stopPoll()
          }
        })()
      }, 2000)
    }
  }

  return {
    events, status, currentNode, verdict, runId, error, resolution,
    startedAt,
    start, resume, cancel, loadFromHistory, reset,
  }
}
