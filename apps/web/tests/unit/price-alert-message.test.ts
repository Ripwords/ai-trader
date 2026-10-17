import { describe, expect, it } from 'vitest'
import { priceAlertMessage, type PriceAlertContext } from '../../server/lib/price-alert-message'
import { pushPayload } from '../../server/lib/notifications-messages'
import type { PriceAlert } from '../../server/lib/alerts-core'
import type { Bar, Snapshot } from '../../server/llm/http'

const alert: PriceAlert = {
  id: 'a1',
  symbol: 'US.NVDA',
  kind: 'price_above',
  threshold: 150,
  note: 'breakout <confirm>',
  status: 'triggered',
  createdAt: '2026-10-03T00:00:00.000Z',
  triggeredAt: '2026-10-17T01:00:00.000Z',
  triggeredPrice: 151.2,
}

const quote: Snapshot = {
  code: 'US.NVDA',
  name: 'NVIDIA',
  lastPrice: 151.2,
  openPrice: 148.1,
  highPrice: 152.4,
  lowPrice: 147.75,
  prevClosePrice: 149.4,
  changeRate: 1.2,
  volume: 182_400_000,
  turnover: 0,
  updateTime: '2026-10-16 15:59:00',
}

const bar = (time: string, close: number, low = close - 1, high = close + 1): Bar => ({ time, open: close, high, low, close, volume: 1, turnover: 0 })
const intraday = Array.from({ length: 30 }, (_, i) => bar(`2026-10-16T09:${String(30 + i).padStart(2, '0')}:00`, 148 + i * 0.1))
const daily = Array.from({ length: 252 }, (_, i) => bar(`2025-10-${i}`, 100 + i * 0.2, 90 + i * 0.2, 101 + i * 0.2))

const full: PriceAlertContext = {
  quote,
  intraday,
  daily,
  position: { quantity: 40, avgCost: 120.5, unrealizedPl: 1228, unrealizedPlPct: 25.48, currency: 'USD' },
}
const none: PriceAlertContext = { quote: null, intraday: null, daily: null, position: null }

const APP = 'https://trader.example.com'

describe('priceAlertMessage', () => {
  it('dedupes on the alert id and names the trigger', () => {
    const m = priceAlertMessage(alert, APP)
    expect(m.kind).toBe('price_alert')
    expect(m.dedupeKey).toBe('alert:a1')
    expect(m.subject).toBe('US.NVDA hit 151.2 (price above 150)')
    expect(m.url).toBe('/portfolio')
  })

  it('formats a day-move alert as a percentage', () => {
    expect(priceAlertMessage({ ...alert, kind: 'pct_move_day', threshold: 5 }, null).subject).toBe('US.NVDA hit 151.2 (day move 5%)')
  })

  it('escapes the note in HTML and keeps it in the text body', () => {
    const m = priceAlertMessage(alert, APP, full)
    expect(m.bodyText).toContain('breakout <confirm>')
    expect(m.bodyHtml).toContain('breakout &lt;confirm&gt;')
    expect(m.bodyHtml).not.toContain('<confirm>')
  })

  it('links to research and alerts only when a public URL is set', () => {
    const m = priceAlertMessage(alert, APP, full)
    expect(m.bodyHtml).toContain('https://trader.example.com/research/US.NVDA')
    expect(m.bodyHtml).toContain('https://trader.example.com/portfolio')
    expect(m.bodyText).toContain('https://trader.example.com/research/US.NVDA')
    expect(priceAlertMessage(alert, null, full).bodyHtml).not.toContain('href')
  })

  describe('with full context', () => {
    const m = priceAlertMessage(alert, APP, full, 'UTC')

    it('heads with name, symbol, price and the day change', () => {
      expect(m.bodyHtml).toContain('AI·TRADER · PRICE ALERT')
      expect(m.bodyHtml).toContain('NVIDIA · US.NVDA')
      expect(m.bodyHtml).toContain('151.20')
      expect(m.bodyHtml).toContain('+1.80 (+1.20%)')
      expect(m.bodyHtml).toContain('Crossed above 150.00 · alert set 3 Oct')
    })

    it('embeds the chart as an inline attachment the HTML references by CID', () => {
      expect(m.attachments).toHaveLength(1)
      const a = m.attachments![0]!
      expect(a.contentType).toBe('image/png')
      expect(a.filename).toBe('US.NVDA-chart.png')
      expect(Buffer.from(a.contentBase64, 'base64').subarray(1, 4).toString('ascii')).toBe('PNG')
      expect(m.bodyHtml).toContain(`src="cid:${a.contentId}"`)
      expect(m.bodyHtml).toContain('width="512"')
      expect(m.bodyHtml).toContain('16 Oct · 5-min')
    })

    it('fills the stats grid', () => {
      for (const label of ['Open', 'Prev close', 'Day range', '52-wk range', 'Volume', 'From threshold']) {
        expect(m.bodyHtml).toContain(label)
      }
      expect(m.bodyHtml).toContain('148.10')
      expect(m.bodyHtml).toContain('147.75 – 152.40')
      expect(m.bodyHtml).toContain('90.00 – 151.20')
      expect(m.bodyHtml).toContain('182.4M')
      expect(m.bodyHtml).toContain('+0.80%')
    })

    it('shows the held position', () => {
      expect(m.bodyHtml).toContain('Your position')
      expect(m.bodyHtml).toContain('40 shares')
      expect(m.bodyHtml).toContain('120.50')
      expect(m.bodyHtml).toContain('+1,228.00 USD (+25.48%)')
    })

    it('carries the same facts in plain text', () => {
      expect(m.bodyText).toContain('NVIDIA · US.NVDA')
      expect(m.bodyText).toContain('Crossed above 150.00')
      expect(m.bodyText).toContain('Day range 147.75 – 152.40')
      expect(m.bodyText).toContain('Your position: 40 shares')
      expect(m.bodyText).toContain('Note: breakout <confirm>')
    })

    it('gives push a one-line summary', () => {
      const p = pushPayload(m)
      expect(p.body).toBe('151.20 (+1.20% today) · crossed above 150.00')
    })
  })

  it('falls back to a daily chart when there are no intraday bars', () => {
    const m = priceAlertMessage(alert, APP, { ...full, intraday: [] }, 'UTC')
    expect(m.attachments).toHaveLength(1)
    expect(m.bodyHtml).toContain('3 months · daily')
  })

  it('leaves out the position block when nothing is held', () => {
    const m = priceAlertMessage(alert, APP, { ...full, position: null })
    expect(m.bodyHtml).not.toContain('Your position')
    expect(m.bodyText).not.toContain('Your position')
  })

  it('degrades to the basic alert with no context', () => {
    for (const m of [priceAlertMessage(alert, APP, none), priceAlertMessage(alert, APP)]) {
      expect(m.attachments).toBeUndefined()
      expect(m.bodyHtml).not.toContain('<img')
      expect(m.bodyHtml).not.toContain('Prev close')
      expect(m.bodyHtml).not.toContain('Your position')
      expect(m.bodyHtml).toContain('US.NVDA')
      expect(m.bodyHtml).toContain('151.20')
      expect(m.bodyHtml).toContain('Crossed above 150.00')
      expect(pushPayload(m).body).toBe('151.20 · crossed above 150.00')
    }
  })

  it('draws a day-move alert threshold from the previous close on the side of the move', () => {
    const m = priceAlertMessage({ ...alert, kind: 'pct_move_day', threshold: 1 }, APP, full, 'UTC')
    expect(m.bodyHtml).toContain('Moved +1.20% today, past 1%')
    expect(m.bodyHtml).toContain('150.89')
    expect(pushPayload(m).body).toBe('151.20 (+1.20% today) · moved past 1%')
  })

  it('drops the threshold from the chart legend when the chart leaves it out', () => {
    const m = priceAlertMessage({ ...alert, threshold: 1 }, APP, full, 'UTC')
    expect(m.attachments).toHaveLength(1)
    expect(m.bodyHtml).not.toContain('Threshold 1.00')
    expect(m.bodyHtml).toContain('Prev close 149.40')
    expect(m.bodyHtml).toContain('Crossed above 1.00')
  })

  it('shows a down day in red', () => {
    const down = { ...quote, lastPrice: 140, prevClosePrice: 145 }
    const m = priceAlertMessage({ ...alert, kind: 'price_below', threshold: 141, triggeredPrice: 140 }, APP, { ...full, quote: down }, 'UTC')
    expect(m.bodyHtml).toContain('-5.00 (-3.45%)')
    expect(m.bodyHtml).toContain('Crossed below 141.00')
    expect(m.bodyHtml).toContain('#b91c1c')
  })
})
