import { describe, expect, it } from 'vitest'
import { chartGeometry, pickChartSeries, renderPriceChartSvg, sessionBars, type ChartInput } from '../../server/lib/price-chart'
import { rasterizeSvg } from '../../server/lib/price-chart-png'
import type { Bar } from '../../server/llm/http'

const bar = (time: string, close: number): Bar => ({ time, open: close, high: close + 1, low: close - 1, close, volume: 100, turnover: 0 })

const input = (over: Partial<ChartInput> = {}): ChartInput => ({
  values: [100, 104, 102, 110],
  threshold: 105,
  prevClose: 101,
  up: true,
  ...over,
})

describe('chartGeometry', () => {
  it('spreads points across the width with higher prices nearer the top', () => {
    const g = chartGeometry(input())!
    expect(g.points).toHaveLength(4)
    expect(g.points[0]![0]).toBe(g.plot.left)
    expect(g.points[3]![0]).toBe(g.plot.right)
    const ys = g.points.map(p => p[1])
    expect(ys[3]).toBeLessThan(ys[0]!)
    expect(ys[1]).toBeLessThan(ys[2]!)
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(g.plot.top)
      expect(y).toBeLessThanOrEqual(g.plot.bottom)
    }
  })

  it('places the threshold between the prices it sits between', () => {
    const g = chartGeometry(input())!
    expect(g.thresholdY).not.toBeNull()
    expect(g.thresholdY!).toBeLessThan(g.points[1]![1])
    expect(g.thresholdY!).toBeGreaterThan(g.points[3]![1])
  })

  it('widens the y-domain to keep a threshold outside the price range on the chart', () => {
    const g = chartGeometry(input({ threshold: 115 }))!
    expect(g.thresholdY!).toBeGreaterThanOrEqual(g.plot.top)
    expect(g.thresholdY!).toBeLessThan(Math.min(...g.points.map(p => p[1])))
  })

  it('leaves out a level so far from the prices that it would flatten the line', () => {
    const g = chartGeometry(input({ values: [340, 344, 342, 345], threshold: 1, prevClose: 342 }))!
    expect(g.thresholdY).toBeNull()
    expect(g.prevCloseY).not.toBeNull()
    const ys = g.points.map(p => p[1])
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan((g.plot.bottom - g.plot.top) * 0.5)
  })

  it('is null with fewer than two prices', () => {
    expect(chartGeometry(input({ values: [] }))).toBeNull()
    expect(chartGeometry(input({ values: [100] }))).toBeNull()
  })

  it('draws a flat series mid-plot instead of dividing by zero', () => {
    const g = chartGeometry(input({ values: [50, 50, 50], threshold: null, prevClose: null }))!
    for (const [, y] of g.points) expect(Number.isFinite(y)).toBe(true)
    expect(g.thresholdY).toBeNull()
    expect(g.prevCloseY).toBeNull()
  })
})

describe('renderPriceChartSvg', () => {
  it('renders a text-free svg with line, area, threshold, prev close and a last-point dot', () => {
    const svg = renderPriceChartSvg(input())!
    expect(svg).toContain('viewBox="0 0 512 180"')
    expect(svg).not.toContain('<text')
    expect(svg).toMatch(/stroke="#d4a96a"[^>]*stroke-dasharray/)
    expect(svg).toContain('<circle')
    expect(svg.match(/<path/g)).toHaveLength(2)
    expect(svg).toContain('#16a34a')
  })

  it('colours a down day red and leaves out lines it has no level for', () => {
    const svg = renderPriceChartSvg(input({ up: false, threshold: null, prevClose: null }))!
    expect(svg).toContain('#dc2626')
    expect(svg).not.toContain('#16a34a')
    expect(svg).not.toContain('#d4a96a')
    expect(svg.match(/<line /g)).toBeNull()
  })

  it('is null for empty or one-bar input', () => {
    expect(renderPriceChartSvg(input({ values: [] }))).toBeNull()
    expect(renderPriceChartSvg(input({ values: [1] }))).toBeNull()
  })
})

describe('sessionBars', () => {
  it('keeps only the latest trading day', () => {
    const bars = [bar('2026-10-15T15:55:00', 1), bar('2026-10-16T09:30:00', 2), bar('2026-10-16T09:35:00', 3)]
    expect(sessionBars(bars).map(b => b.close)).toEqual([2, 3])
    expect(sessionBars([])).toEqual([])
  })
})

describe('pickChartSeries', () => {
  const intraday = [bar('2026-10-16T09:30:00', 10), bar('2026-10-16T09:35:00', 11)]
  const daily = Array.from({ length: 100 }, (_, i) => bar(`2026-06-${String(i).padStart(2, '0')}T00:00:00`, i))

  it('prefers the intraday session', () => {
    expect(pickChartSeries(intraday, daily)).toEqual({ kind: 'intraday', values: [10, 11], date: '2026-10-16' })
  })

  it('falls back to about three months of daily closes', () => {
    const s = pickChartSeries(intraday.slice(0, 1), daily)!
    expect(s.kind).toBe('daily')
    expect(s.values).toHaveLength(63)
    expect(s.values.at(-1)).toBe(99)
  })

  it('is null when neither series has two bars', () => {
    expect(pickChartSeries(null, daily.slice(0, 1))).toBeNull()
    expect(pickChartSeries(null, null)).toBeNull()
  })
})

describe('rasterizeSvg', () => {
  it('renders a PNG at twice the display width', () => {
    const png = rasterizeSvg(renderPriceChartSvg(input())!, 1024)
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(1024)
    expect(png.readUInt32BE(20)).toBe(360)
  })
})
