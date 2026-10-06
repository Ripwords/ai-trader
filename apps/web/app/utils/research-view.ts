import type { Tone } from './portfolio-view'

const DAY_MS = 24 * 60 * 60 * 1000

export interface RunStats {
  total: number
  avgCost: number | null
  completionRate: number | null
}

export function runStats(
  rows: readonly { status: string, startedAt: string, costUsd: number | null }[],
  now: number,
): RunStats {
  const window = rows.filter(r => new Date(r.startedAt).getTime() >= now - DAY_MS)
  if (window.length === 0) return { total: 0, avgCost: null, completionRate: null }
  const completed = window.filter(r => r.status === 'complete').length
  const sumCost = window.reduce((a, r) => a + (r.costUsd ?? 0), 0)
  return {
    total: window.length,
    avgCost: sumCost / window.length,
    completionRate: Math.round((completed / window.length) * 100),
  }
}

export function fmtRate(rate: number | null): string {
  return rate === null ? '—' : `${rate}%`
}

export function rateTone(rate: number | null): Tone {
  if (rate === null) return 'neutral'
  if (rate >= 90) return 'up'
  if (rate >= 50) return 'neutral'
  return 'down'
}

export function fmtUsd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`
}

export function fmtConfidence(n: number | null | undefined): string {
  return n == null ? '—' : `${n}%`
}

export function ratingTone(rating: string | null): Tone {
  const v = rating?.toLowerCase()
  if (v === 'strong-buy' || v === 'buy') return 'up'
  if (v === 'reduce' || v === 'sell') return 'down'
  return 'neutral'
}

/** Postgres serialises timestamps as `2026-05-10 15:35:40.874689+00`. */
export function toIso(s: string | null | undefined): string | null {
  if (!s) return null
  if (s.includes('T')) return s
  return s.replace(' ', 'T').replace(/\+00$/, 'Z')
}

export function ageLabel(when: string | null | undefined, now: number): string {
  const iso = toIso(when)
  const t = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(t)) return '—'
  const min = Math.floor(Math.max(0, now - t) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

/** Rows arrive newest first. */
export function latestVerdict<T extends { rating: string | null }>(rows: readonly T[]): T | null {
  return rows.find(r => r.rating !== null) ?? null
}

export type ReportPhase = 'connecting' | 'streaming' | 'done' | 'error'
export type SectionState = 'ready' | 'loading' | 'unavailable'

export function sectionState(hasData: boolean, phase: ReportPhase): SectionState {
  if (hasData) return 'ready'
  return phase === 'done' || phase === 'error' ? 'unavailable' : 'loading'
}
