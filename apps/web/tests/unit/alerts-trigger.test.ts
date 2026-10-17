import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb } from './support/fake-db'

let fake = createFakeDb()
vi.mock('../../db/client', () => ({ getDb: () => fake.db }))

const { triggerAlert } = await import('../../server/lib/alerts')
const { runAlertEvaluation, gatherAlertContext } = await import('../../server/lib/alerts-evaluate')

const snapshot = (lastPrice: number, prevClosePrice: number) => ({
  code: 'US.AAPL', name: 'Apple', lastPrice, prevClosePrice, openPrice: 229, highPrice: 231, lowPrice: 228, changeRate: 0, volume: 1000, turnover: 0, updateTime: '',
})
const bars = (n: number, day = '2026-10-16') => Array.from({ length: n }, (_, i) => ({
  time: `${day}T09:${String(30 + i).padStart(2, '0')}:00`, open: 1, high: 231, low: 228, close: 228 + i * 0.1, volume: 1, turnover: 0,
}))
const kline = async ({ code, ktype }: { code: string; ktype: string; num: number }) => ({ code, ktype: ktype as '5m', bars: bars(20) })

const alertRow = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  symbol: 'US.AAPL',
  kind: 'price_above',
  threshold: '1',
  note: null,
  status: 'active',
  createdAt: new Date('2026-10-16T00:00:00.000Z'),
  triggeredAt: null,
  triggeredPrice: null,
  ...over,
})

beforeEach(() => {
  fake = createFakeDb()
})

describe('triggerAlert', () => {
  it('flips the alert, guarded on active, and enqueues its notification', async () => {
    fake = createFakeDb(() => [], {
      updateReturning: () => [alertRow({ status: 'triggered', triggeredAt: new Date(), triggeredPrice: '230.5' })],
    })
    const alert = await triggerAlert('a1', 230.5)
    expect(fake.inserts.find(i => i.table === 'notifications')!.values.attachments).toBeNull()
    expect(alert).toMatchObject({ id: 'a1', status: 'triggered', triggeredPrice: 230.5 })
    expect(fake.updates[0]!.params).toContain('active')
    const queued = fake.inserts.filter(i => i.table === 'notifications')
    expect(queued).toHaveLength(1)
    expect(queued[0]!.values).toMatchObject({ kind: 'price_alert', dedupeKey: 'alert:a1' })
  })

  it('enqueues nothing when a cancel won the race', async () => {
    expect(await triggerAlert('a1', 230.5)).toBeNull()
    expect(fake.inserts).toEqual([])
  })
})

describe('runAlertEvaluation', () => {
  it('triggers crossed alerts and skips a symbol whose quote failed', async () => {
    fake = createFakeDb(
      table => table === 'price_alerts' ? [alertRow(), alertRow({ id: 'a2', symbol: 'US.TSLA' })] : [],
      { updateReturning: u => [alertRow({ status: 'triggered', triggeredAt: new Date(), triggeredPrice: '230', id: u.params.find(p => p === 'a1' || p === 'a2') })] },
    )
    const client = {
      getSnapshot: vi.fn(async ({ code }: { code: string }) => {
        if (code === 'US.TSLA') throw new Error('opend down')
        return snapshot(230, 228)
      }),
      getKline: kline,
    }
    const res = await runAlertEvaluation(client)
    expect(res).toEqual({ checked: 2, triggered: 1 })
    expect(fake.inserts.filter(i => i.table === 'notifications').map(i => i.values.dedupeKey)).toEqual(['alert:a1'])
  })

  it('makes no quote call when nothing is armed', async () => {
    const client = { getSnapshot: vi.fn(async () => snapshot(1, 1)), getKline: vi.fn(kline) }
    expect(await runAlertEvaluation(client)).toEqual({ checked: 0, triggered: 0 })
    expect(client.getSnapshot).not.toHaveBeenCalled()
  })

  it('fetches chart data only for symbols that trigger', async () => {
    fake = createFakeDb(table => table === 'price_alerts' ? [alertRow({ threshold: '500' })] : [])
    const client = { getSnapshot: vi.fn(async () => snapshot(230, 228)), getKline: vi.fn(kline) }
    expect(await runAlertEvaluation(client)).toEqual({ checked: 1, triggered: 0 })
    expect(client.getKline).not.toHaveBeenCalled()
  })

  it('stores the rendered chart and position with the notification', async () => {
    fake = createFakeDb(
      table => table === 'price_alerts' ? [alertRow()] : [],
      { updateReturning: () => [alertRow({ status: 'triggered', triggeredAt: new Date(), triggeredPrice: '230' })] },
    )
    const findPosition = vi.fn(async () => ({ quantity: 10, avgCost: 150, unrealizedPl: 800, unrealizedPlPct: 53.3, currency: 'USD' }))
    const res = await runAlertEvaluation({ getSnapshot: async () => snapshot(230, 228), getKline: kline, findPosition })
    expect(res.triggered).toBe(1)
    const values = fake.inserts.find(i => i.table === 'notifications')!.values
    expect(values.attachments).toEqual([expect.objectContaining({ contentId: 'price-chart', contentType: 'image/png' })])
    expect(values.bodyHtml).toContain('Your position')
    expect(values.bodyHtml).toContain('Apple · US.AAPL')
    expect(findPosition).toHaveBeenCalledWith('US.AAPL')
  })

  it('still triggers when every enrichment fetch fails or hangs', async () => {
    fake = createFakeDb(
      table => table === 'price_alerts' ? [alertRow()] : [],
      { updateReturning: () => [alertRow({ status: 'triggered', triggeredAt: new Date(), triggeredPrice: '230' })] },
    )
    const client = {
      getSnapshot: async () => snapshot(230, 228),
      getKline: vi.fn(async ({ ktype }: { ktype: string }) => {
        if (ktype === '5m') throw new Error('opend down')
        return new Promise<never>(() => {})
      }),
      findPosition: async () => { throw new Error('ghostfolio down') },
    }
    const res = await runAlertEvaluation(client, { enrichTimeoutMs: 20 })
    expect(res).toEqual({ checked: 1, triggered: 1 })
    const values = fake.inserts.find(i => i.table === 'notifications')!.values
    expect(values.attachments).toBeNull()
    expect(values.bodyHtml).toContain('Apple · US.AAPL')
    expect(values.bodyHtml).not.toContain('Your position')
  })
})

describe('gatherAlertContext', () => {
  it('keeps the quote, trims intraday to the latest session and nulls failed pieces', async () => {
    const source = {
      getSnapshot: async () => snapshot(230, 228),
      getKline: async ({ code, ktype }: { code: string; ktype: string }) => {
        if (ktype === '1d') throw new Error('no daily')
        return { code, ktype: '5m' as const, bars: [...bars(3, '2026-10-15'), ...bars(5)] }
      },
    }
    const ctx = await gatherAlertContext(source, 'US.AAPL', snapshot(230, 228), 50)
    expect(ctx.quote?.name).toBe('Apple')
    expect(ctx.intraday).toHaveLength(5)
    expect(ctx.daily).toBeNull()
    expect(ctx.position).toBeNull()
  })
})
