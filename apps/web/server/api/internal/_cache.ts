/**
 * Tiny in-memory TTL cache for ``/api/internal/*`` data routes.
 *
 * The TradingAgents toolkit calls back here multiple times per run for the
 * same (symbol, kind) combination — once per analyst that touches Yahoo
 * fundamentals, etc. Without a cache, a single run on US.NVDA spends ~10
 * round-trips re-fetching the same Yahoo bundle. A 24h TTL is enough to
 * collapse all those calls into one upstream hit per (symbol, kind, day)
 * while still picking up overnight data refreshes.
 *
 * Keyed by ``${path}?symbol=…``. The map lives in module scope (one
 * instance per Nitro worker); that's fine because:
 *   - the worker is single-process for our self-host
 *   - cache misses are cheap, so a worker restart just costs one upstream
 *     refetch per symbol
 *   - we don't need cross-worker coherence
 *
 * Each entry stores a ``signature`` so we can dedupe by full JSON shape
 * (different ``max_results``, etc.) while still honouring TTL.
 */

interface CacheEntry<T> {
  /** Full URL the route was called with — full key, not just the path. */
  key: string
  /** Wall-clock millisecond when the entry was written. */
  storedAt: number
  /** Cached payload. */
  value: T
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

const store = new Map<string, CacheEntry<unknown>>()

/**
 * Look up a cached entry. Returns ``undefined`` on miss or stale (TTL
 * expired). Stale entries are eagerly evicted to keep the map bounded.
 */
export function cacheGet<T>(key: string, ttlMs: number = DEFAULT_TTL_MS): T | undefined {
  const hit = store.get(key)
  if (!hit) return undefined
  // ``>=`` rather than ``>`` so a 0ms TTL is interpretable as "stale
  // immediately" — useful for tests that want to exercise the eviction
  // path without fighting wall-clock granularity.
  if (Date.now() - hit.storedAt >= ttlMs) {
    store.delete(key)
    return undefined
  }
  return hit.value as T
}

/** Store a value under ``key`` with the current wall-clock. */
export function cacheSet<T>(key: string, value: T): void {
  store.set(key, { key, storedAt: Date.now(), value })
}

/**
 * Evict every entry whose key starts with ``prefix``. Useful when an
 * upstream change invalidates a slice (e.g. a manual refresh of all Yahoo
 * data for a symbol).
 */
export function cacheEvict(prefix: string): number {
  let evicted = 0
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) {
      store.delete(k)
      evicted++
    }
  }
  return evicted
}

/** Test-only helper to wipe the cache between specs. */
export function _cacheReset(): void {
  store.clear()
}
