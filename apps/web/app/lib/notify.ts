import type { FinishedRun } from '../../server/lib/agents/runs-query'

export async function requestRunNotificationPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission() } catch { /* ignore */ }
  }
}

export function fireRunNotification(run: FinishedRun): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const done = run.status === 'complete'
  const verdict = run.rating
    ? `${run.rating}${run.confidence != null ? ` · conf ${run.confidence}` : ''}`
    : run.status
  const n = new Notification(`${run.symbol} research ${done ? 'done' : 'failed'}`, {
    body: done ? verdict : 'the run did not complete',
    tag: `research-${run.runId}`,
  })
  n.onclick = () => {
    window.focus()
    window.location.href = `/research?run=${encodeURIComponent(run.runId)}`
    n.close()
  }
}
