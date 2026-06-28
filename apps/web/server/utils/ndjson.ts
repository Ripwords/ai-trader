import type { AgentEvent } from '../../types/agents'

/**
 * Stateless NDJSON line splitter. Pass the leftover ``rest`` from the previous
 * call as ``buf`` to stitch across chunk boundaries. Malformed / blank lines
 * are skipped silently (the upstream stream is best-effort).
 */
export function splitNdjson(buf: string, chunk: string): { events: AgentEvent[]; rest: string } {
  const combined = buf + chunk
  const lines = combined.split('\n')
  const rest = lines.pop() ?? ''
  const events: AgentEvent[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed) as AgentEvent)
    } catch {
      /* skip malformed */
    }
  }
  return { events, rest }
}
