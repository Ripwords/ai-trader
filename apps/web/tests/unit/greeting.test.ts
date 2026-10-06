import { describe, expect, it } from 'vitest'
import { dayPart } from '../../app/utils/greeting'

describe('dayPart', () => {
  it.each([
    [0, 'morning'],
    [5, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [17, 'afternoon'],
    [18, 'evening'],
    [23, 'evening'],
  ] as const)('hour %i is %s', (hour, part) => {
    expect(dayPart(hour)).toBe(part)
  })
})
