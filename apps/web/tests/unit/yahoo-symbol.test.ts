import { describe, expect, it } from 'vitest'
import { toYahooSymbol } from '../../server/lib/yahoo'

describe('toYahooSymbol', () => {
  it.each([
    ['US.NVDA', 'NVDA'],
    ['HK.00700', '0700.HK'],
    ['SH.600519', '600519.SS'],
    ['SZ.000001', '000001.SZ'],
    ['MY.1066', '1066.KL'],
    ['MY.0828EA', '0828EA.KL'],
    ['SG.D05', 'D05.SI'],
    ['JP.7203', '7203.T'],
    ['AU.BHP', 'BHP.AX'],
    ['CA.SHOP', 'SHOP.TO'],
    ['NVDA', 'NVDA'],
  ])('%s → %s', (input, expected) => {
    expect(toYahooSymbol(input)).toBe(expected)
  })
})
