import { pickOrderFields, type OrderSession, type OrderSettings, type OrderType, type TimeInForce, type TrailType, type TrdEnv } from '../../server/lib/order-types'

export const ORDERS_TABS = [
  { value: 'active', label: 'active' },
  { value: 'approvals', label: 'approvals' },
] as const

export type OrdersTab = typeof ORDERS_TABS[number]['value']

export function parseOrdersTab(q: unknown): OrdersTab {
  return ORDERS_TABS.find(t => t.value === q)?.value ?? 'active'
}

const TYPE_LABELS: Record<string, string> = {
  NORMAL: 'limit',
  MARKET: 'market',
  STOP: 'stop',
  STOP_LIMIT: 'stop limit',
  MARKET_IF_TOUCHED: 'market if touched',
  LIMIT_IF_TOUCHED: 'limit if touched',
  TRAILING_STOP: 'trailing stop',
  TRAILING_STOP_LIMIT: 'trailing stop limit',
}

/** moomoo can report types this app never places; those show as sent. */
export function orderTypeLabel(type: string | null | undefined): string {
  if (!type) return '—'
  return TYPE_LABELS[type] ?? type
}

const SESSION_LABELS: Record<string, string> = {
  RTH: 'regular hours',
  ETH: 'extended hours',
  OVERNIGHT: 'overnight',
  ALL: 'all sessions',
}

export function sessionLabel(session: string | null | undefined): string {
  if (!session) return '—'
  return SESSION_LABELS[session] ?? session
}

const TIF_LABELS: Record<string, string> = { DAY: 'day only', GTC: 'good till cancelled' }

export function tifLabel(tif: string | null | undefined): string {
  if (!tif) return '—'
  return TIF_LABELS[tif] ?? tif
}

export function fillLabel(dealt: number | null | undefined, qty: number): string {
  return `${dealt ?? 0}/${qty}`
}

interface PriceFields {
  order_type?: string | null
  price?: number | null
  trigger_price?: number | null
  trail_type?: string | null
  trail_value?: number | null
  trail_spread?: number | null
}

const money = (n: number) => n.toFixed(2)

/** The price column: limit, trigger and trail, whichever the type uses. */
export function priceSummary(o: PriceFields): string {
  const type = o.order_type ?? 'NORMAL'
  if (type === 'MARKET') return 'market'
  const parts: string[] = []
  if (o.trigger_price) parts.push(`trig ${money(o.trigger_price)}`)
  if (o.trail_value) {
    parts.push(o.trail_type === 'RATIO' ? `trail ${o.trail_value}%` : `trail ${money(o.trail_value)}`)
  }
  if (o.trail_spread) parts.push(`spread ${money(o.trail_spread)}`)
  const limitPriced = type === 'NORMAL' || type === 'STOP_LIMIT' || type === 'LIMIT_IF_TOUCHED'
  if (limitPriced && o.price) parts.push(`lmt ${money(o.price)}`)
  return parts.length ? parts.join(' · ') : '—'
}

function pricePhrase(o: OrderSettings): string {
  const type = o.order_type ?? 'NORMAL'
  const label = orderTypeLabel(type)
  const bits: string[] = []
  if (o.trigger_price) bits.push(`trigger ${money(o.trigger_price)}`)
  if (o.trail_value) bits.push(o.trail_type === 'RATIO' ? `trail ${o.trail_value}%` : `trail ${money(o.trail_value)}`)
  if (o.trail_spread) bits.push(`spread ${money(o.trail_spread)}`)
  if (o.price && (type === 'NORMAL' || type === 'STOP_LIMIT' || type === 'LIMIT_IF_TOUCHED')) {
    bits.push(type === 'NORMAL' ? `at ${money(o.price)}` : `limit ${money(o.price)}`)
  }
  return bits.length ? `${label} ${bits.join(', ')}` : label
}

/** One sentence for a confirm modal, so the owner reads exactly what will be sent. */
export function describeOrder(o: OrderSettings, where: { trdEnv: TrdEnv; accountLabel: string }): string {
  const text = `${o.side} ${o.qty} ${o.code}, ${pricePhrase(o)}, ${tifLabel(o.time_in_force ?? 'DAY')}, ${sessionLabel(o.session ?? 'RTH')}, on ${where.accountLabel}.`
  return where.trdEnv === 'REAL' ? `${text} This is a LIVE order with real money.` : text
}

const REMARK_ID = /^q:([0-9a-f-]{36})$/i

/** Orders approved from the queue carry remark "q:<proposal id>". */
export function proposalIdFromRemark(remark: string | null | undefined): string | null {
  return remark ? REMARK_ID.exec(remark)?.[1] ?? null : null
}

/** The proposal fields an order is built from (camelCase, as the queue stores them). */
export interface ProposalOrderFields {
  symbol: string
  side: 'BUY' | 'SELL'
  qty: number
  orderType: OrderType
  price: number | null
  triggerPrice: number | null
  trailType: TrailType | null
  trailValue: number | null
  trailSpread: number | null
  timeInForce: TimeInForce
  session: OrderSession
}

export function proposalSettings(p: ProposalOrderFields): OrderSettings {
  return pickOrderFields({
    code: p.symbol,
    side: p.side,
    qty: p.qty,
    order_type: p.orderType,
    price: p.price ?? undefined,
    trigger_price: p.triggerPrice ?? undefined,
    trail_type: p.trailType ?? undefined,
    trail_value: p.trailValue ?? undefined,
    trail_spread: p.trailSpread ?? undefined,
    time_in_force: p.timeInForce,
    session: p.session,
  })
}

/** The order fields as the queue routes take them; unused fields go as null so an edit clears them. */
export function orderBody(o: OrderSettings) {
  const picked = pickOrderFields(o)
  return {
    qty: picked.qty,
    orderType: picked.order_type ?? 'NORMAL',
    price: picked.price ?? null,
    triggerPrice: picked.trigger_price ?? null,
    trailType: picked.trail_type ?? null,
    trailValue: picked.trail_value ?? null,
    trailSpread: picked.trail_spread ?? null,
    timeInForce: picked.time_in_force ?? 'DAY',
    session: picked.session ?? 'RTH',
  }
}
