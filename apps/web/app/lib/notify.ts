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

// --- Price alerts ----------------------------------------------------------

import type { PriceAlert } from '../../server/lib/alerts-core'

function fmtAlertNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value)
}

/** "US.NVDA hit 151.2 (price_above 150)" — pure so it's unit-testable. */
export function alertNotificationTitle(alert: PriceAlert): string {
  const price = alert.triggeredPrice ?? alert.threshold
  const suffix = alert.kind === 'pct_move_day' ? '%' : ''
  return `${alert.symbol} hit ${fmtAlertNumber(price)} (${alert.kind} ${fmtAlertNumber(alert.threshold)}${suffix})`
}

export function fireAlertNotification(alert: PriceAlert): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const n = new Notification(alertNotificationTitle(alert), {
    body: alert.note ?? 'price alert triggered',
    tag: `alert-${alert.id}`,
  })
  n.onclick = () => {
    window.focus()
    n.close()
  }
}
