/**
 * Wall-clock times in a named IANA zone, shared by the server (reminder
 * emails) and the browser (reminder form and list), so both read and show
 * times in the zone set in Settings → Notifications rather than whatever
 * zone the server or the device happens to run in.
 */

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

function zoneParts(at: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)
  const out: Record<string, number> = {}
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value)
  return out
}

/** Milliseconds the zone is ahead of UTC at `at`. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = zoneParts(at, timeZone)
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!)
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/**
 * `YYYY-MM-DDTHH:mm` (what `<input type="datetime-local">` yields) read as a
 * wall-clock time in `timeZone`. Null for malformed input or an unknown zone.
 */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL_RE.exec(local)
  if (!m) return null
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
  try {
    // Two passes settle the offset when the first guess lands across a DST change.
    let utc = naive - zoneOffsetMs(new Date(naive), timeZone)
    utc = naive - zoneOffsetMs(new Date(utc), timeZone)
    return new Date(utc)
  } catch {
    return null
  }
}

/** The `datetime-local` value for `at` in `timeZone`. */
export function utcToZonedLocal(at: Date, timeZone: string): string {
  const p = zoneParts(at, timeZone)
  const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

/** "Sat, 17 Oct 2026, 09:00 GMT+8". */
export function formatInZone(iso: string | Date, timeZone: string): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  if (Number.isNaN(d.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).format(d)
  } catch {
    return d.toISOString()
  }
}
