/** Scheduler heartbeat, shared by the server (writes it) and Settings / AlertsPanel (show it). */

export const SCHEDULER_TASKS = ['alerts:evaluate', 'reminders:dispatch', 'notify:send'] as const
export type SchedulerTask = typeof SCHEDULER_TASKS[number]

export interface HeartbeatEntry {
  lastRunAt: string
  lastOk: boolean
  lastError: string | null
}

/** app_settings key 'scheduler_heartbeat'. */
export type SchedulerHeartbeat = Partial<Record<string, HeartbeatEntry>>

/** Tasks run every minute; three missed ticks means the scheduler is not running. */
export const HEARTBEAT_STALE_MS = 3 * 60_000

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

export function describeHeartbeat(entry: HeartbeatEntry | undefined, now: number): { label: string; stale: boolean; ok: boolean; error: string | null } {
  if (!entry) return { label: 'never checked', stale: true, ok: false, error: null }
  const at = Date.parse(entry.lastRunAt)
  if (Number.isNaN(at)) return { label: 'never checked', stale: true, ok: false, error: null }
  return {
    label: `last checked ${ago(now - at)}`,
    stale: now - at > HEARTBEAT_STALE_MS,
    ok: entry.lastOk,
    error: entry.lastError,
  }
}
