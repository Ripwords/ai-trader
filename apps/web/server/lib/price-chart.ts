/**
 * Price-alert email chart — pure. Builds a text-free SVG (the alpine image has
 * no fonts, so every label lives in the email HTML); ./price-chart-png.ts
 * rasterizes it.
 */
import type { Bar } from '../llm/http'

export const CHART_WIDTH = 512
export const CHART_HEIGHT = 180

const PAD_X = 8
const PAD_Y = 12
const DAILY_BARS = 63

export const CHART_COLORS = {
  up: '#16a34a',
  down: '#dc2626',
  threshold: '#d4a96a',
  prevClose: '#9a948a',
} as const

export interface ChartInput {
  /** Closes, oldest first. */
  values: number[]
  /**
   * Price level the alert fires at; drawn as an amber dashed line. Each level
   * is drawn only within one price-range of the series, so a distant one
   * cannot flatten the line.
   */
  threshold: number | null
  /** Drawn as a grey dotted line. Only meaningful on an intraday chart. */
  prevClose: number | null
  up: boolean
}

export interface ChartGeometry {
  plot: { left: number; right: number; top: number; bottom: number }
  points: Array<[number, number]>
  thresholdY: number | null
  prevCloseY: number | null
}

const usable = (n: number | null): n is number => n != null && Number.isFinite(n) && n > 0

export function chartGeometry(input: ChartInput): ChartGeometry | null {
  const values = input.values.filter(v => Number.isFinite(v))
  if (values.length < 2) return null
  const vLo = Math.min(...values)
  const vHi = Math.max(...values)
  const reach = Math.max(vHi - vLo, vHi * 0.01)
  const fits = (n: number | null): n is number => usable(n) && n >= vLo - reach && n <= vHi + reach
  const threshold = fits(input.threshold) ? input.threshold : null
  const prevClose = fits(input.prevClose) ? input.prevClose : null
  const levels = [threshold, prevClose].filter(usable)
  let lo = Math.min(...values, ...levels)
  let hi = Math.max(...values, ...levels)
  const span = hi - lo
  const margin = span > 0 ? span * 0.08 : Math.abs(hi) * 0.01 || 1
  lo -= margin
  hi += margin

  const plot = { left: PAD_X, right: CHART_WIDTH - PAD_X, top: PAD_Y, bottom: CHART_HEIGHT - PAD_Y }
  const y = (v: number) => round(plot.bottom - ((v - lo) / (hi - lo)) * (plot.bottom - plot.top))
  const step = (plot.right - plot.left) / (values.length - 1)
  return {
    plot,
    points: values.map((v, i) => [round(plot.left + i * step), y(v)]),
    thresholdY: threshold != null ? y(threshold) : null,
    prevCloseY: prevClose != null ? y(prevClose) : null,
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

export function renderPriceChartSvg(input: ChartInput): string | null {
  const g = chartGeometry(input)
  if (!g) return null
  const color = input.up ? CHART_COLORS.up : CHART_COLORS.down
  const line = g.points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  const first = g.points[0]!
  const last = g.points[g.points.length - 1]!
  const area = `${line} L${last[0]} ${g.plot.bottom} L${first[0]} ${g.plot.bottom} Z`
  const hline = (y: number, stroke: string, dash: string) =>
    `<line x1="${g.plot.left}" y1="${y}" x2="${g.plot.right}" y2="${y}" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="${dash}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}">`
    + `<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${color}" stop-opacity="0.18"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>`
    + `</linearGradient></defs>`
    + `<rect width="${CHART_WIDTH}" height="${CHART_HEIGHT}" fill="#ffffff"/>`
    + (g.prevCloseY != null ? hline(g.prevCloseY, CHART_COLORS.prevClose, '1.5 3.5') : '')
    + `<path d="${area}" fill="url(#fill)"/>`
    + `<path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
    + (g.thresholdY != null ? hline(g.thresholdY, CHART_COLORS.threshold, '6 4') : '')
    + `<circle cx="${last[0]}" cy="${last[1]}" r="6" fill="${color}" fill-opacity="0.2"/>`
    + `<circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>`
    + `</svg>`
}

const barDate = (b: Bar) => b.time.slice(0, 10)

/** Bars from the most recent trading day in the response. */
export function sessionBars(bars: Bar[]): Bar[] {
  const last = bars.at(-1)
  if (!last) return []
  const day = barDate(last)
  return bars.filter(b => barDate(b) === day)
}

export type ChartSeries =
  | { kind: 'intraday'; values: number[]; date: string }
  | { kind: 'daily'; values: number[] }

/** The latest session's 5-min closes, else about three months of daily closes. */
export function pickChartSeries(intraday: Bar[] | null, daily: Bar[] | null): ChartSeries | null {
  if (intraday && intraday.length >= 2) {
    return { kind: 'intraday', values: intraday.map(b => b.close), date: barDate(intraday[0]!) }
  }
  if (daily && daily.length >= 2) return { kind: 'daily', values: daily.slice(-DAILY_BARS).map(b => b.close) }
  return null
}
