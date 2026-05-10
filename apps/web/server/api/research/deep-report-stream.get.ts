// SSE stream for the deep risk report. The page connects via useEventSource
// and renders sections progressively as price, chart, fundamentals and llm
// events land.

import { streamRiskReport } from '../../lib/risk-report'

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const symbol = typeof q.symbol === 'string' ? q.symbol.trim() : ''
  if (!symbol) {
    throw createError({ statusCode: 400, statusMessage: 'symbol required' })
  }

  const stream = createEventStream(event)
  const ac = new AbortController()

  // 15s heartbeat keeps reverse-proxy idle timeouts at bay during the slow
  // LLM leg (cold reports take 30-60s end-to-end).
  const heartbeat = setInterval(() => {
    stream.push({ event: 'ping', data: '' }).catch(() => {})
  }, 15_000)

  stream.onClosed(() => {
    clearInterval(heartbeat)
    ac.abort()
  })

  ;(async () => {
    try {
      for await (const ev of streamRiskReport({ symbol, signal: ac.signal })) {
        if (ac.signal.aborted) break
        await stream.push({ event: ev.kind, data: JSON.stringify(ev) })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await stream
        .push({ event: 'error', data: JSON.stringify({ kind: 'error', source: 'pipeline', message, fatal: true }) })
        .catch(() => {})
    } finally {
      await stream.close().catch(() => {})
    }
  })()

  return stream.send()
})
