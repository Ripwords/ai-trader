import { describe, expect, it } from 'vitest'
import { runSymbolMatches, runSymbolPattern } from '../../types/run-symbol'

describe('runSymbolMatches', () => {
  it('matches a stored moomoo code against the bare ticker in the URL', () => {
    expect(runSymbolMatches('US.AAPL', 'AAPL')).toBe(true)
  })

  it('matches identical symbols', () => {
    expect(runSymbolMatches('US.AAPL', 'US.AAPL')).toBe(true)
    expect(runSymbolMatches('0700.HK', '0700.HK')).toBe(true)
  })

  it('does not treat a Yahoo exchange suffix as a market prefix', () => {
    expect(runSymbolMatches('0700.HK', 'HK')).toBe(false)
  })

  it('does not match a different ticker that shares a suffix', () => {
    expect(runSymbolMatches('US.AAPL', 'PL')).toBe(false)
  })
})

describe('runSymbolPattern', () => {
  it('agrees with runSymbolMatches and escapes regex characters', () => {
    const re = new RegExp(runSymbolPattern('BRK.B'))
    expect(re.test('US.BRK.B')).toBe(true)
    expect(re.test('BRK.B')).toBe(true)
    expect(re.test('US.BRKXB')).toBe(false)
  })
})
