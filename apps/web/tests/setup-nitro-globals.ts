// Nitro auto-imports don't exist under vitest. Server modules that wrap a
// function in defineCachedFunction at load time get a pass-through, so any
// test importing them transitively still loads; tests that care about caching
// override it with stubNitroCache() from tests/fixtures/nitro-cache.ts.
;(globalThis as { defineCachedFunction?: unknown }).defineCachedFunction ??= <T>(fn: T): T => fn
