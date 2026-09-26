interface Bucket {
  failures: number
  resetAt: number
}

/** Fixed-window count of failed logins per key, held in memory. */
export function createLoginLimiter(opts: { max: number, windowMs: number }) {
  const buckets = new Map<string, Bucket>()

  function prune(now: number): void {
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key)
  }

  return {
    /** Seconds until `key` may try again, or null when it is not blocked. */
    retryAfterS(key: string, now = Date.now()): number | null {
      const b = buckets.get(key)
      if (!b || b.resetAt <= now || b.failures < opts.max) return null
      return Math.max(1, Math.ceil((b.resetAt - now) / 1000))
    },
    fail(key: string, now = Date.now()): void {
      prune(now)
      const b = buckets.get(key)
      if (b) b.failures += 1
      else buckets.set(key, { failures: 1, resetAt: now + opts.windowMs })
    },
    reset(key: string): void {
      buckets.delete(key)
    },
    size(): number {
      return buckets.size
    },
  }
}
