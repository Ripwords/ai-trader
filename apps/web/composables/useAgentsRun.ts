import { ref, shallowRef } from 'vue'
import type { AgentEvent, Rating } from '../types/agents'

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
  confidence: number
  rationale: string
}

interface StartOpts {
  max_debate_rounds?: number
  deep_thinking?: boolean
}

export function useAgentsRun() {
  const events = shallowRef<AgentEvent[]>([])
  const status = ref<'idle' | 'running' | 'complete' | 'failed' | 'cancelled'>('idle')
  const currentNode = ref<string | null>(null)
  const verdict = ref<VerdictState | null>(null)
  const runId = ref<string | null>(null)
  const error = ref<string | null>(null)
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
    controller = new AbortController()

    const res = await fetch('/api/research/agents-run', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol, ...opts }),
    })
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
    controller = new AbortController()

    const res = await fetch('/api/research/agents-resume', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: originalRunId }),
    })
    await consumeStream(res, controller)
  }

  function cancel() {
    controller?.abort()
  }

  return { events, status, currentNode, verdict, runId, error, start, resume, cancel }
}
