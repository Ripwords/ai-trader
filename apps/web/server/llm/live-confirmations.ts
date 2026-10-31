/**
 * Confirmation phrases already spent on a REAL order. A phrase confirms one
 * order: without this, a second tool call in the same turn, or a retry that
 * resends the same message, placed the order again. Kept in memory: the web
 * runs as one process, and a restart losing the record errs towards asking.
 */
const TTL_MS = 24 * 60 * 60 * 1000
const used = new Map<string, number>()

/** Claim `key` for one order; false if it was already claimed. */
export function claimLiveConfirmation(key: string, now = Date.now()): boolean {
  for (const [k, at] of used) if (now - at > TTL_MS) used.delete(k)
  if (used.has(key)) return false
  used.set(key, now)
  return true
}

/** Hand `key` back after the api refused the order, so nothing was sent. */
export function releaseLiveConfirmation(key: string): void {
  used.delete(key)
}

export function resetLiveConfirmations(): void {
  used.clear()
}
