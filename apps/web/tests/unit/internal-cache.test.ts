import { afterEach, describe, expect, it } from 'vitest'
import { _cacheReset, cacheEvict, cacheGet, cacheSet } from '../../server/api/internal/_cache'

afterEach(() => _cacheReset())

describe('internal cache', () => {
  it('round-trips a value under a key', () => {
    cacheSet('yahoo:balance-sheet:AAPL', { value: 1 })
    expect(cacheGet<{ value: number }>('yahoo:balance-sheet:AAPL')).toEqual({ value: 1 })
  })

  it('returns undefined for an unknown key', () => {
    expect(cacheGet<unknown>('missing')).toBeUndefined()
  })

  it('treats stale entries as misses and evicts them', () => {
    cacheSet('yahoo:fundamentals:NVDA', 'old')
    // 0ms TTL forces every read to be stale.
    expect(cacheGet<string>('yahoo:fundamentals:NVDA', 0)).toBeUndefined()
    // Confirm the entry was evicted, not just hidden.
    expect(cacheGet<string>('yahoo:fundamentals:NVDA')).toBeUndefined()
  })

  it('evicts by prefix', () => {
    cacheSet('yahoo:balance-sheet:AAPL', 'a')
    cacheSet('yahoo:cashflow:AAPL', 'b')
    cacheSet('yahoo:balance-sheet:NVDA', 'c')
    const n = cacheEvict('yahoo:balance-sheet:')
    expect(n).toBe(2)
    expect(cacheGet<string>('yahoo:cashflow:AAPL')).toBe('b')
    expect(cacheGet<string>('yahoo:balance-sheet:AAPL')).toBeUndefined()
  })
})
