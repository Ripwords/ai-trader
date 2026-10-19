import { defineNitroPlugin, useStorage } from 'nitropack/runtime'
import redisDriver from 'unstorage/drivers/redis'
import { redisCacheOptions } from '../lib/redis-cache'

// Mounted at runtime rather than in nuxt.config's `nitro.storage`, which is
// serialized at build time when the image has no REDIS_URL.
export default defineNitroPlugin(() => {
  const opts = redisCacheOptions(process.env)
  if (!opts) return
  const storage = useStorage()
  // Without dispose, unmount completes synchronously, so the mount below can't race it.
  void storage.unmount('cache', false)
  storage.mount('cache', redisDriver(opts))
  console.info('[cache] using Redis for the cache storage')
})
