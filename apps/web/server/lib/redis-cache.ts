import type { RedisOptions } from 'unstorage/drivers/redis'

/**
 * Driver options for mounting Nitro's `cache` storage on Redis, or null to
 * keep the default in-memory cache (tests, `nuxi dev` without Redis).
 *
 * Every defineCachedFunction / defineCachedEventHandler reads this storage on
 * the request path, so a Redis outage must turn into a fast cache miss: with
 * the offline queue on, ioredis would hold each command until it reconnects.
 */
export function redisCacheOptions(env: Record<string, string | undefined>): RedisOptions | null {
  const url = env.REDIS_URL?.trim()
  if (!url) return null
  return {
    url,
    base: 'ai-trader:cache',
    preConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
  }
}
