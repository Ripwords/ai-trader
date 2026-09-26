/**
 * Wrap a periodic job so runs never overlap, and a run that never settles
 * releases the busy flag after `timeoutMs` instead of stopping the loop for
 * good. The stuck run is abandoned, not cancelled.
 */
export function createGuardedTick(
  run: () => Promise<void>,
  timeoutMs: number,
  onTimeout?: () => void,
): () => Promise<void> {
  let inFlight = false

  return async function tick() {
    if (inFlight) return
    inFlight = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        onTimeout?.()
        resolve()
      }, timeoutMs)
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    })
    try {
      await Promise.race([run(), deadline])
    } finally {
      clearTimeout(timer)
      inFlight = false
    }
  }
}
