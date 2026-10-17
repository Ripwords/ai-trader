/**
 * The price-alert notification. Pure apart from rasterizing the chart, which
 * is deterministic: the outbox stores the result, so retries send the same
 * bytes. Every section is built from a nullable piece of PriceAlertContext
 * and left out when that piece is missing.
 */
import type { PriceAlert } from './alerts-core'
import type { EmailAttachment } from './email/resend'
import type { Bar, Snapshot } from '../llm/http'
import {
  absolute,
  EMAIL_MONO,
  emailEyebrow,
  emailShell,
  escapeHtml,
  type NotificationMessage,
} from './notifications-messages'
import { CHART_COLORS, CHART_WIDTH, chartGeometry, pickChartSeries, renderPriceChartSvg, type ChartSeries } from './price-chart'
import { rasterizeSvg } from './price-chart-png'

export interface AlertPosition {
  quantity: number
  avgCost: number | null
  unrealizedPl: number
  unrealizedPlPct: number
  currency: string | null
}

/** Market data gathered best-effort when the alert fires. Any piece may be missing. */
export interface PriceAlertContext {
  quote: Snapshot | null
  /** The latest session's 5-min bars. */
  intraday: Bar[] | null
  /** About a year of daily bars: the 52-week range, and the chart when there is no session. */
  daily: Bar[] | null
  position: AlertPosition | null
}

export const NO_ALERT_CONTEXT: PriceAlertContext = { quote: null, intraday: null, daily: null, position: null }

const ALERT_KIND_LABEL: Record<PriceAlert['kind'], string> = {
  price_above: 'price above',
  price_below: 'price below',
  pct_move_day: 'day move',
}

const INK = '#0d0f12'
const BODY = '#2b2f36'
const MUTED = '#8a8478'
const RULE = '#ece8e0'
const AMBER = '#d4a96a'
const UP_TEXT = '#15803d'
const DOWN_TEXT = '#b91c1c'
const CHART_ID = 'price-chart'
const FULL_YEAR_BARS = 240

const positive = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0

function fmtPrice(n: number): string {
  const digits = Math.abs(n) >= 1 ? 2 : 4
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '')
const signedPrice = (n: number) => `${sign(n)}${fmtPrice(Math.abs(n))}`
const signedPct = (n: number) => `${sign(n)}${Math.abs(n).toFixed(2)}%`
const compact = (n: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
const fmtQty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 })

function shortDate(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(at)
  }
  catch {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(at)
  }
}

interface Stat { label: string; value: string; tone?: 'up' | 'down' }

interface ChartView {
  attachment: EmailAttachment
  alt: string
  seriesLabel: string
  threshold: string | null
  prevClose: string | null
}

/** Everything the HTML and text bodies show, decided once. */
interface PriceAlertView {
  title: string
  price: string
  change: { text: string; up: boolean } | null
  crossed: string
  pushLine: string
  chart: ChartView | null
  stats: Stat[]
  position: Stat[] | null
  note: string | null
  links: Array<{ href: string; label: string; primary: boolean }>
}

/** The price the alert line sits at. A day-move alert's line is prevClose ± pct on the side the price moved. */
function thresholdLevel(alert: PriceAlert, last: number, prevClose: number | null): number | null {
  if (alert.kind !== 'pct_move_day') return alert.threshold
  if (!positive(prevClose)) return null
  const dir = last >= prevClose ? 1 : -1
  return prevClose * (1 + dir * alert.threshold / 100)
}

function chartView(alert: PriceAlert, series: ChartSeries, level: number | null, prevClose: number | null, up: boolean): ChartView | null {
  const intraday = series.kind === 'intraday'
  const input = { values: series.values, threshold: level, prevClose: intraday ? prevClose : null, up }
  const geometry = chartGeometry(input)
  const svg = renderPriceChartSvg(input)
  if (!geometry || !svg) return null
  let png: Buffer
  try {
    png = rasterizeSvg(svg, CHART_WIDTH * 2)
  }
  catch (err) {
    console.error('[alerts] chart render failed for', alert.symbol, err instanceof Error ? err.message : err)
    return null
  }
  const seriesLabel = intraday ? `${shortDate(new Date(`${series.date}T12:00:00Z`), 'UTC')} · 5-min` : '3 months · daily'
  return {
    attachment: { filename: `${alert.symbol}-chart.png`, contentId: CHART_ID, contentType: 'image/png', contentBase64: png.toString('base64') },
    alt: `${alert.symbol} price chart, ${seriesLabel}`,
    seriesLabel,
    threshold: level != null && geometry.thresholdY != null ? fmtPrice(level) : null,
    prevClose: prevClose != null && geometry.prevCloseY != null ? fmtPrice(prevClose) : null,
  }
}

function yearRange(daily: Bar[] | null): Stat | null {
  if (!daily || daily.length < 2) return null
  const lo = Math.min(...daily.map(b => b.low).filter(positive))
  const hi = Math.max(...daily.map(b => b.high).filter(positive))
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  return { label: daily.length >= FULL_YEAR_BARS ? '52-wk range' : `${daily.length}-day range`, value: `${fmtPrice(lo)} – ${fmtPrice(hi)}` }
}

function buildView(alert: PriceAlert, appUrl: string | null, ctx: PriceAlertContext, timeZone: string): PriceAlertView {
  const q = ctx.quote
  const price = alert.triggeredPrice ?? (positive(q?.lastPrice) ? q.lastPrice : alert.threshold)
  const prevClose = positive(q?.prevClosePrice) ? q.prevClosePrice : null
  const change = prevClose != null ? { abs: price - prevClose, pct: (price - prevClose) / prevClose * 100 } : null
  const level = thresholdLevel(alert, price, prevClose)

  const condition = alert.kind === 'price_above'
    ? `crossed above ${fmtPrice(alert.threshold)}`
    : alert.kind === 'price_below'
      ? `crossed below ${fmtPrice(alert.threshold)}`
      : `moved past ${alert.threshold}%`
  const crossedHead = alert.kind === 'pct_move_day' && change
    ? `Moved ${signedPct(change.pct)} today, past ${alert.threshold}%`
    : condition.charAt(0).toUpperCase() + condition.slice(1)

  const series = pickChartSeries(ctx.intraday, ctx.daily)
  const up = change ? change.abs >= 0 : series ? series.values.at(-1)! >= series.values[0]! : true

  const stats: Stat[] = []
  if (q && positive(q.openPrice)) stats.push({ label: 'Open', value: fmtPrice(q.openPrice) })
  if (prevClose != null) stats.push({ label: 'Prev close', value: fmtPrice(prevClose) })
  if (q && positive(q.lowPrice) && positive(q.highPrice)) stats.push({ label: 'Day range', value: `${fmtPrice(q.lowPrice)} – ${fmtPrice(q.highPrice)}` })
  const range = yearRange(ctx.daily)
  if (range) stats.push(range)
  if (q && positive(q.volume)) stats.push({ label: 'Volume', value: compact(q.volume) })
  if (q && level != null) stats.push({ label: 'From threshold', value: signedPct((price - level) / level * 100) })

  const p = ctx.position
  const ccy = p?.currency ? ` ${p.currency}` : ''
  const position: Stat[] | null = p
    ? [
        { label: 'Quantity', value: `${fmtQty(p.quantity)} shares` },
        ...(positive(p.avgCost) ? [{ label: 'Avg cost', value: fmtPrice(p.avgCost) }] : []),
        { label: 'Market value', value: `${fmtPrice(p.quantity * price)}${ccy}` },
        { label: 'Unrealized P&L', value: `${signedPrice(p.unrealizedPl)}${ccy} (${signedPct(p.unrealizedPlPct)})`, tone: p.unrealizedPl >= 0 ? 'up' : 'down' },
      ]
    : null

  const research = absolute(`/research/${encodeURIComponent(alert.symbol)}`, appUrl)
  const manage = absolute('/portfolio', appUrl)
  return {
    title: q?.name ? `${q.name} · ${alert.symbol}` : alert.symbol,
    price: fmtPrice(price),
    change: change ? { text: `${signedPrice(change.abs)} (${signedPct(change.pct)})`, up: change.abs >= 0 } : null,
    crossed: `${crossedHead} · alert set ${shortDate(new Date(alert.createdAt), timeZone)}`,
    pushLine: `${fmtPrice(price)}${change ? ` (${signedPct(change.pct)} today)` : ''} · ${condition}`,
    chart: series ? chartView(alert, series, level, prevClose, up) : null,
    stats,
    position,
    note: alert.note,
    links: [
      ...(research ? [{ href: research, label: 'Open research', primary: true }] : []),
      ...(manage ? [{ href: manage, label: 'Manage alerts', primary: false }] : []),
    ],
  }
}

const toneColor = (tone: Stat['tone']) => (tone === 'up' ? UP_TEXT : tone === 'down' ? DOWN_TEXT : INK)
const label = (text: string) =>
  `<div style="font-family:${EMAIL_MONO};font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:${MUTED};margin-bottom:4px">${escapeHtml(text)}</div>`

/** A grid of label/value cells, `cols` per row. */
function statGrid(stats: Stat[], cols: number): string {
  const rows: string[] = []
  for (let i = 0; i < stats.length; i += cols) {
    const cells = stats.slice(i, i + cols).map(s =>
      `<td valign="top" width="${Math.floor(100 / cols)}%" style="padding:10px 8px 10px 0">${label(s.label)}`
      + `<div style="font-size:14px;line-height:1.35;color:${toneColor(s.tone)};font-variant-numeric:tabular-nums">${escapeHtml(s.value)}</div></td>`)
    while (cells.length < cols) cells.push(`<td width="${Math.floor(100 / cols)}%"></td>`)
    rows.push(`<tr>${cells.join('')}</tr>`)
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows.join('')}</table>`
}

const swatch = (style: string) => `<span style="display:inline-block;width:16px;height:0;border-top:2px ${style};vertical-align:middle;margin-right:6px"></span>`

function renderHtml(v: PriceAlertView): string {
  const parts: string[] = [emailEyebrow('AI·TRADER · PRICE ALERT')]

  parts.push(`<div style="font-size:14px;color:${BODY};margin:0 0 6px">${escapeHtml(v.title)}</div>`)
  parts.push(`<div style="margin:0 0 4px"><span style="font-size:32px;line-height:1.1;font-weight:600;color:${INK};font-variant-numeric:tabular-nums;letter-spacing:-.01em">${escapeHtml(v.price)}</span>`
    + (v.change ? `<span style="font-size:15px;font-weight:600;color:${v.change.up ? UP_TEXT : DOWN_TEXT};margin-left:10px;white-space:nowrap">${escapeHtml(v.change.text)}</span>` : '')
    + `</div>`)
  parts.push(`<div style="margin:16px 0 0;padding:9px 12px;background:#faf6ee;border-left:3px solid ${AMBER};font-size:13px;line-height:1.45;color:${BODY}">${escapeHtml(v.crossed)}</div>`)

  if (v.chart) {
    const c = v.chart
    const legend = [
      c.threshold ? `${swatch(`dashed ${CHART_COLORS.threshold}`)}Threshold ${escapeHtml(c.threshold)}` : '',
      c.prevClose ? `${swatch(`dotted ${CHART_COLORS.prevClose}`)}Prev close ${escapeHtml(c.prevClose)}` : '',
    ].filter(Boolean).map(item => `<span style="display:inline-block;white-space:nowrap;margin-right:14px">${item}</span>`).join('')
    parts.push(`<div style="margin:20px 0 0"><img src="cid:${escapeHtml(c.attachment.contentId)}" width="${CHART_WIDTH}" alt="${escapeHtml(c.alt)}" style="display:block;width:100%;max-width:${CHART_WIDTH}px;height:auto;border:0"></div>`)
    parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 0;font-size:12px;color:${MUTED}"><tr>`
      + `<td style="padding:0">${legend}</td>`
      + `<td align="right" style="padding:0;font-family:${EMAIL_MONO};font-size:10px;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap">${escapeHtml(c.seriesLabel)}</td>`
      + `</tr></table>`)
  }

  if (v.stats.length) {
    parts.push(`<div style="margin:20px 0 0;border-top:1px solid ${RULE}">${statGrid(v.stats, 3)}</div>`)
  }

  if (v.position) {
    parts.push(`<div style="margin:16px 0 0;padding:14px 16px 6px;background:#f8f6f2;border:1px solid ${RULE}">`
      + `<div style="font-family:${EMAIL_MONO};font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${INK}">Your position</div>`
      + statGrid(v.position, 2)
      + `</div>`)
  }

  if (v.note) {
    parts.push(`<div style="margin:16px 0 0">${label('Note')}<div style="font-size:14px;line-height:1.5;color:${BODY};white-space:pre-wrap">${escapeHtml(v.note)}</div></div>`)
  }

  if (v.links.length) {
    const buttons = v.links.map(l => {
      const style = l.primary
        ? `background:${INK};color:${AMBER};border:1px solid ${INK}`
        : `background:#ffffff;color:${INK};border:1px solid #cfc9bd`
      return `<td style="padding:0 8px 0 0"><a href="${escapeHtml(l.href)}" style="display:inline-block;padding:10px 16px;${style};text-decoration:none;font-family:${EMAIL_MONO};font-size:12px;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap">${escapeHtml(l.label)}</a></td>`
    }).join('')
    parts.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0"><tr>${buttons}</tr></table>`)
  }

  parts.push(`<div style="margin:24px 0 0;padding-top:12px;border-top:1px solid ${RULE};font-size:12px;color:${MUTED}">Alerts fire once, then switch off.</div>`)
  return emailShell(parts.join(''))
}

function renderText(v: PriceAlertView): string {
  const paras = [
    v.pushLine,
    `${v.title} · ${v.price}${v.change ? ` ${v.change.text}` : ''}\n${v.crossed}`,
  ]
  if (v.stats.length) paras.push(v.stats.map(s => `${s.label} ${s.value}`).join(' · '))
  if (v.position) paras.push(`Your position: ${v.position.map((s, i) => (i ? `${s.label} ${s.value}` : s.value)).join(' · ')}`)
  if (v.note) paras.push(`Note: ${v.note}`)
  if (v.links.length) paras.push(v.links.map(l => `${l.label}: ${l.href}`).join('\n'))
  return paras.join('\n\n')
}

export function priceAlertMessage(
  alert: PriceAlert,
  appUrl: string | null,
  context: PriceAlertContext = NO_ALERT_CONTEXT,
  timeZone = 'UTC',
): NotificationMessage {
  const price = alert.triggeredPrice ?? alert.threshold
  const condition = `${ALERT_KIND_LABEL[alert.kind]} ${alert.threshold}${alert.kind === 'pct_move_day' ? '%' : ''}`
  const view = buildView(alert, appUrl, context, timeZone)
  return {
    kind: 'price_alert',
    dedupeKey: `alert:${alert.id}`,
    subject: `${alert.symbol} hit ${price} (${condition})`,
    bodyText: renderText(view),
    bodyHtml: renderHtml(view),
    url: '/portfolio',
    ...(view.chart ? { attachments: [view.chart.attachment] } : {}),
  }
}
