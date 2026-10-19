import { describe, expect, it } from 'vitest'
import { redisCacheOptions } from '../../server/lib/redis-cache'

describe('redisCacheOptions', () => {
  it('keeps the in-memory cache when REDIS_URL is unset or blank', () => {
    expect(redisCacheOptions({})).toBeNull()
    expect(redisCacheOptions({ REDIS_URL: '  ' })).toBeNull()
  })

  it('fails fast instead of queueing commands while Redis is down', () => {
    const opts = redisCacheOptions({ REDIS_URL: 'redis://redis:6379' })
    expect(opts).toMatchObject({
      url: 'redis://redis:6379',
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    })
  })
})
