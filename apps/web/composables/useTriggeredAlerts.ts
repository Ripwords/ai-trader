import { onMounted, onUnmounted } from 'vue'
import type { PriceAlert } from '../server/lib/alerts-core'
import type { TriggeredAlertsResponse } from '../server/lib/alerts'

const NOTIFIED_KEY = 'aitrader.notifiedAlerts'
const NOTIFIED_CAP = 200
const POLL_MS = 15000

/**
 * Pure reducer: given the triggered-alerts response and the set of
 * already-notified alert ids, decide which triggers are new (need a
 * notification) and produce the next persisted notified-id list (capped,
 * most-recent-kept). Mirrors computeNotifications in useActiveRuns.
 */
export function computeAlertNotifications(
  resp: TriggeredAlertsResponse,
  notified: Set<string>,
  cap = NOTIFIED_CAP,
): { toNotify: PriceAlert[]; nextNotified: string[] } {
  const toNotify = resp.triggered.filter(a => !notified.has(a.id))
  const merged = [...notified, ...toNotify.map(a => a.id)]
  const nextNotified = merged.slice(Math.max(0, merged.length - cap))
  return { toNotify, nextNotified }
}

function loadNotified(): Set<string> {
  try {
    const raw = localStorage.getItem(NOTIFIED_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}
function saveNotified(ids: string[]) {
  try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}

export function useTriggeredAlerts() {
  let timer: ReturnType<typeof setInterval> | null = null
  let permissionAsked = false

  async function tick() {
    let resp: TriggeredAlertsResponse
    try {
      const r = await fetch('/api/alerts/triggered', { headers: { 'content-type': 'application/json' } })
      if (!r.ok) return
      resp = await r.json() as TriggeredAlertsResponse
    } catch {
      return
    }

    const { requestRunNotificationPermission, fireAlertNotification } = await import('../app/lib/notify')
    // Ask for permission lazily while alerts are armed, so the grant is in
    // place by the time one fires.
    if (!permissionAsked && (resp.activeCount > 0 || resp.triggered.length > 0)) {
      permissionAsked = true
      void requestRunNotificationPermission()
    }

    const notified = loadNotified()
    const { toNotify, nextNotified } = computeAlertNotifications(resp, notified)
    if (toNotify.length === 0) return
    for (const alert of toNotify) fireAlertNotification(alert)
    saveNotified(nextNotified)
  }

  onMounted(() => {
    void tick()
    timer = setInterval(() => { void tick() }, POLL_MS)
  })
  onUnmounted(() => { if (timer) clearInterval(timer) })
}
