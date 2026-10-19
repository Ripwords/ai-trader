import { vi } from 'vitest'

interface CacheOpts {
  getKey?: (...args: never[]) => string
  validate?: (entry: { value: unknown }) => boolean
}

/**
 * Installs a `defineCachedFunction` global that memoizes like Nitro's: keyed
 * by `getKey` (or the JSON of the args), storing only entries that pass
 * `validate`, and never storing a thrown error. Call before importing the module.
 */
export function stubNitroCache(): void {
  vi.stubGlobal('defineCachedFunction', <A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts: CacheOpts = {}) => {
    const memo = new Map<string, R>()
    return async (...args: A): Promise<R> => {
      const key = opts.getKey ? opts.getKey(...(args as never[])) : JSON.stringify(args)
      if (memo.has(key)) return memo.get(key) as R
      const value = await fn(...args)
      if (opts.validate?.({ value }) !== false) memo.set(key, value)
      return value
    }
  })
}
