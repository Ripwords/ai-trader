import { describe, expect, it } from 'vitest'
import { formatUsdCost } from '../../app/utils/usage-view'

describe('formatUsdCost', () => {
  it('marks a missing price as unpriced', () => {
    expect(formatUsdCost(null)).toBe('unpriced')
  })

  it('shows zero as cents', () => {
    expect(formatUsdCost(0)).toBe('$0.00')
  })

  it('rounds a cent or more to two decimals with grouping', () => {
    expect(formatUsdCost(0.01)).toBe('$0.01')
    expect(formatUsdCost(12.3456)).toBe('$12.35')
    expect(formatUsdCost(1234.5)).toBe('$1,234.50')
  })

  it('keeps two significant digits below a cent', () => {
    expect(formatUsdCost(0.0045)).toBe('$0.0045')
    expect(formatUsdCost(0.000123)).toBe('$0.00012')
    expect(formatUsdCost(0.0000004)).toBe('$0.0000004')
    expect(formatUsdCost(0.004)).toBe('$0.004')
  })

  it('does not print a sub-cent value that rounds up as $0.010', () => {
    expect(formatUsdCost(0.00999)).toBe('$0.01')
  })
})
