import { describe, expect, it } from 'vitest'
import { computeAlertNotifications } from '../../composables/useTriggeredAlerts'
import { alertNotificationTitle } from '../../app/lib/notify'
import type { PriceAlert } from '../../server/lib/alerts-core'

const alert = (over: Partial<PriceAlert> = {}): PriceAlert => ({
  id: 'a1',
  symbol: 'US.NVDA',
  kind: 'price_above',
  threshold: 150,
  note: null,
  status: 'triggered',
  createdAt: '2026-07-18T00:00:00.000Z',
  triggeredAt: '2026-07-18T01:00:00.000Z',
  triggeredPrice: 151.2,
  ...over,
})

const resp = (triggered: PriceAlert[], activeCount = 0) => ({ triggered, activeCount })

describe('computeAlertNotifications', () => {
  it('returns triggered alerts not yet notified', () => {
    const r = computeAlertNotifications(resp([alert()]), new Set())
    expect(r.toNotify.map(a => a.id)).toEqual(['a1'])
    expect(r.nextNotified).toContain('a1')
  })

  it('does not re-notify an already-notified alert', () => {
    const r = computeAlertNotifications(resp([alert()]), new Set(['a1']))
    expect(r.toNotify).toEqual([])
    expect(r.nextNotified).toContain('a1')
  })

  it('caps the persisted notified set to the most recent ids', () => {
    const r = computeAlertNotifications(resp([]), new Set(['old1', 'old2', 'old3']), 2)
    expect(r.nextNotified).toHaveLength(2)
  })
})

describe('alertNotificationTitle', () => {
  it('formats a price_above trigger', () => {
    expect(alertNotificationTitle(alert())).toBe('US.NVDA hit 151.2 (price_above 150)')
  })

  it('formats a price_below trigger', () => {
    expect(alertNotificationTitle(alert({ kind: 'price_below', threshold: 90, triggeredPrice: 89.5 })))
      .toBe('US.NVDA hit 89.5 (price_below 90)')
  })

  it('formats a pct_move_day trigger', () => {
    expect(alertNotificationTitle(alert({ kind: 'pct_move_day', threshold: 5, triggeredPrice: 94 })))
      .toBe('US.NVDA hit 94 (pct_move_day 5%)')
  })

  it('falls back to the threshold when triggered price is missing', () => {
    expect(alertNotificationTitle(alert({ triggeredPrice: null })))
      .toBe('US.NVDA hit 150 (price_above 150)')
  })
})
