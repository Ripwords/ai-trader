import type { FinishedRun } from '../../server/lib/agents/runs-query'

export async function requestRunNotificationPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission() } catch { /* ignore */ }
  }
}

/** The in-tab notice for a finished run. Same link and tag as the server push for that run. */
export function runNotification(run: FinishedRun): { title: string; body: string; tag: string; url: string } {
  const body = {
    complete: run.rating ? `${run.rating}${run.confidence != null ? ` · conf ${run.confidence}` : ''}` : 'finished',
    failed: 'the run did not complete',
    cancelled: 'the run was stopped',
  }[run.status]
  const outcome = { complete: 'done', failed: 'failed', cancelled: 'cancelled' }[run.status]
  return {
    title: `${run.symbol} research ${outcome}`,
    body,
    tag: `run:${run.runId}`,
    url: `/research/${encodeURIComponent(run.symbol)}?run=${encodeURIComponent(run.runId)}`,
  }
}

export function fireRunNotification(run: FinishedRun): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const { title, body, tag, url } = runNotification(run)
  const n = new Notification(title, { body, tag })
  n.onclick = () => {
    window.focus()
    window.location.href = url
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
