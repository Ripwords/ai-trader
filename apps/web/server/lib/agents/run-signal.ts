/**
 * In-process wake-up for run tailers. The tee bumps a run's version after
 * each row and after its terminal status, so a tailer in the same process
 * reads new rows at once instead of on its next poll. Tailers in another
 * process never see it and fall back to polling, which stays the source of
 * truth.
 */
const versions = new Map<string, number>()
const waiters = new Map<string, Set<() => void>>()

/** Read before querying the run, then pass to waitForRun. */
export function runVersion(runId: string): number {
  return versions.get(runId) ?? 0
}

/** `final` marks the last notification, after which the run is forgotten. */
export function notifyRun(runId: string, opts: { final?: boolean } = {}): void {
  if (opts.final) versions.delete(runId)
  else versions.set(runId, runVersion(runId) + 1)
  const set = waiters.get(runId)
  if (!set) return
  waiters.delete(runId)
  for (const wake of set) wake()
}

/**
 * Resolves on the first of: the run's version moving past `seen`, `ms`
 * elapsing, or `signal` aborting.
 */
export function waitForRun(runId: string, seen: number, ms: number, signal?: AbortSignal): Promise<void> {
  if (runVersion(runId) !== seen || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', wake)
      waiters.get(runId)?.delete(wake)
      if (waiters.get(runId)?.size === 0) waiters.delete(runId)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    signal?.addEventListener('abort', wake, { once: true })
    let set = waiters.get(runId)
    if (!set) waiters.set(runId, (set = new Set()))
    set.add(wake)
  })
}
