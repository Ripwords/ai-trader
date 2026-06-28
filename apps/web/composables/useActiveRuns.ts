import { onMounted, onUnmounted } from 'vue'
import type { ActiveRunsResponse, FinishedRun } from '../server/lib/agents/runs-query'

const NOTIFIED_KEY = 'aitrader.notifiedRuns'
const NOTIFIED_CAP = 200
const POLL_MS = 4000

/**
 * Pure reducer: given the active-runs response and the set of already-notified
 * run ids, decide which finished runs are new (need a notification) and produce
 * the next persisted notified-id list (capped, most-recent-kept).
 */
export function computeNotifications(
  resp: ActiveRunsResponse,
  notified: Set<string>,
  cap = NOTIFIED_CAP,
): { toNotify: FinishedRun[]; nextNotified: string[] } {
  const toNotify = resp.recentlyFinished.filter(r => !notified.has(r.runId))
  // Keep existing ids first, then append the newly-notified, then cap by
  // dropping the oldest (front).
  const merged = [...notified, ...toNotify.map(r => r.runId)]
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

export function useActiveRuns() {
  let timer: ReturnType<typeof setInterval> | null = null
  let permissionAsked = false

  async function tick() {
    let resp: ActiveRunsResponse
    try {
      const r = await fetch('/api/research/active-runs', { headers: { 'content-type': 'application/json' } })
      if (!r.ok) return
      resp = await r.json() as ActiveRunsResponse
    } catch {
      return
    }

    const { requestRunNotificationPermission, fireRunNotification } = await import('../app/lib/notify')
    // Ask for permission lazily the first time a run is in flight.
    if (!permissionAsked && resp.active.length > 0) {
      permissionAsked = true
      void requestRunNotificationPermission()
    }

    const notified = loadNotified()
    const { toNotify, nextNotified } = computeNotifications(resp, notified)
    if (toNotify.length === 0) return
    for (const run of toNotify) fireRunNotification(run)
    saveNotified(nextNotified)
  }

  onMounted(() => {
    void tick()
    timer = setInterval(() => { void tick() }, POLL_MS)
  })
  onUnmounted(() => { if (timer) clearInterval(timer) })
}
