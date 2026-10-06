import { describe, expect, it } from 'vitest'
import { toNumber } from '../../server/lib/research-intelligence'

describe('toNumber', () => {
  it('keeps a missing confidence as null instead of 0', () => {
    expect(toNumber(null)).toBeNull()
  })

  it('parses numeric strings from raw SQL rows', () => {
    expect(toNumber('62')).toBe(62)
    expect(toNumber(41)).toBe(41)
  })

  it('treats non-numeric text as null', () => {
    expect(toNumber('n/a')).toBeNull()
  })
})
