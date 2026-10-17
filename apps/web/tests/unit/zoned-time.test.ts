import { describe, expect, it } from 'vitest'
import { formatInZone, utcToZonedLocal, zonedLocalToUtc } from '../../types/zoned-time'

describe('zonedLocalToUtc', () => {
  it('reads a wall-clock time in a fixed-offset zone', () => {
    expect(zonedLocalToUtc('2026-10-17T09:00', 'Asia/Kuala_Lumpur')?.toISOString()).toBe('2026-10-17T01:00:00.000Z')
  })

  it('honours daylight saving on either side of the change', () => {
    // New York: EDT (UTC-4) in October, EST (UTC-5) in December.
    expect(zonedLocalToUtc('2026-10-17T09:30', 'America/New_York')?.toISOString()).toBe('2026-10-17T13:30:00.000Z')
    expect(zonedLocalToUtc('2026-12-17T09:30', 'America/New_York')?.toISOString()).toBe('2026-12-17T14:30:00.000Z')
  })

  it('rejects malformed input and unknown zones', () => {
    expect(zonedLocalToUtc('tomorrow 9am', 'Asia/Kuala_Lumpur')).toBeNull()
    expect(zonedLocalToUtc('2026-10-17T09:00', 'Mars/Olympus')).toBeNull()
  })
})

describe('utcToZonedLocal', () => {
  it('round-trips with zonedLocalToUtc', () => {
    const at = new Date('2026-10-17T13:30:00.000Z')
    expect(utcToZonedLocal(at, 'America/New_York')).toBe('2026-10-17T09:30')
    expect(zonedLocalToUtc(utcToZonedLocal(at, 'Asia/Kuala_Lumpur'), 'Asia/Kuala_Lumpur')?.getTime()).toBe(at.getTime())
  })
})

describe('formatInZone', () => {
  it('shows the time in the given zone with the zone named', () => {
    const text = formatInZone('2026-10-17T01:00:00.000Z', 'Asia/Kuala_Lumpur')
    expect(text).toContain('17 Oct 2026')
    expect(text).toContain('09:00')
    expect(text).toMatch(/GMT\+8/)
  })

  it('returns a dash for an invalid date', () => {
    expect(formatInZone('nope', 'Asia/Kuala_Lumpur')).toBe('—')
  })
})
