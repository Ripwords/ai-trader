import { describe, expect, it } from 'vitest'
import {
  ageLabel,
  fmtConfidence,
  fmtRate,
  fmtUsd,
  latestVerdict,
  rateTone,
  ratingTone,
  runStats,
  sectionState,
  toIso,
} from '../../app/utils/research-view'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const HOUR = 60 * 60 * 1000

function run(over: Partial<{ status: string, startedAt: string, costUsd: number | null }>) {
  return { status: 'complete', startedAt: new Date(NOW - HOUR).toISOString(), costUsd: 0.5, ...over }
}

describe('runStats', () => {
  it('reports no rate and no average when the window has no runs', () => {
    expect(runStats([], NOW)).toEqual({ total: 0, avgCost: null, completionRate: null })
  })

  it('ignores runs older than 24h', () => {
    const old = run({ startedAt: new Date(NOW - 25 * HOUR).toISOString() })
    expect(runStats([old], NOW)).toEqual({ total: 0, avgCost: null, completionRate: null })
  })

  it('computes total, average cost and a rounded completion rate', () => {
    const rows = [run({}), run({ status: 'failed', costUsd: null }), run({ costUsd: 1 })]
    expect(runStats(rows, NOW)).toEqual({ total: 3, avgCost: 0.5, completionRate: 67 })
  })
})

describe('fmtRate / rateTone', () => {
  it('shows a dash in a neutral tone when there is no rate', () => {
    expect(fmtRate(null)).toBe('—')
    expect(rateTone(null)).toBe('neutral')
  })

  it('tones by threshold', () => {
    expect(fmtRate(92)).toBe('92%')
    expect(rateTone(92)).toBe('up')
    expect(rateTone(60)).toBe('neutral')
    expect(rateTone(0)).toBe('down')
  })
})

describe('fmtUsd', () => {
  it('formats dollars, dash for null', () => {
    expect(fmtUsd(0.456)).toBe('$0.46')
    expect(fmtUsd(null)).toBe('—')
  })
})

describe('fmtConfidence', () => {
  it('formats a percent, dash for null or undefined', () => {
    expect(fmtConfidence(72)).toBe('72%')
    expect(fmtConfidence(0)).toBe('0%')
    expect(fmtConfidence(null)).toBe('—')
    expect(fmtConfidence(undefined)).toBe('—')
  })
})

describe('ratingTone', () => {
  it('maps buy-side up, sell-side down, everything else neutral', () => {
    expect(ratingTone('Buy')).toBe('up')
    expect(ratingTone('strong-buy')).toBe('up')
    expect(ratingTone('sell')).toBe('down')
    expect(ratingTone('reduce')).toBe('down')
    expect(ratingTone('hold')).toBe('neutral')
    expect(ratingTone(null)).toBe('neutral')
  })
})

describe('toIso', () => {
  it('normalises a Postgres timestamp and passes ISO through', () => {
    expect(toIso('2026-05-10 15:35:40.874689+00')).toBe('2026-05-10T15:35:40.874689Z')
    expect(toIso('2026-05-10T15:35:40Z')).toBe('2026-05-10T15:35:40Z')
    expect(toIso(null)).toBeNull()
    expect(toIso('')).toBeNull()
  })
})

describe('ageLabel', () => {
  it('buckets elapsed time into a short relative label', () => {
    expect(ageLabel(new Date(NOW - 30 * 1000).toISOString(), NOW)).toBe('just now')
    expect(ageLabel(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW)).toBe('5m ago')
    expect(ageLabel(new Date(NOW - 3 * HOUR).toISOString(), NOW)).toBe('3h ago')
    expect(ageLabel(new Date(NOW - 74 * HOUR).toISOString(), NOW)).toBe('3d ago')
  })

  it('reads a Postgres timestamp and returns a dash for missing or bad input', () => {
    expect(ageLabel('2026-10-03 12:00:00+00', NOW)).toBe('3d ago')
    expect(ageLabel(null, NOW)).toBe('—')
    expect(ageLabel('not a date', NOW)).toBe('—')
  })
})

describe('latestVerdict', () => {
  it('returns the newest row that carries a rating', () => {
    const rows = [
      { id: 'a', rating: null },
      { id: 'b', rating: 'buy' },
      { id: 'c', rating: 'sell' },
    ]
    expect(latestVerdict(rows)?.id).toBe('b')
  })

  it('returns null when no run has a rating', () => {
    expect(latestVerdict([{ id: 'a', rating: null }])).toBeNull()
  })
})

describe('sectionState', () => {
  it('is ready once the data is present, whatever the phase', () => {
    expect(sectionState(true, 'streaming')).toBe('ready')
    expect(sectionState(true, 'done')).toBe('ready')
  })

  it('keeps loading while the stream is open', () => {
    expect(sectionState(false, 'connecting')).toBe('loading')
    expect(sectionState(false, 'streaming')).toBe('loading')
  })

  it('becomes unavailable once the stream has ended without the data', () => {
    expect(sectionState(false, 'done')).toBe('unavailable')
    expect(sectionState(false, 'error')).toBe('unavailable')
  })
})
