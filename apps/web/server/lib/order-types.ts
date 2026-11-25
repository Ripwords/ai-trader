import { z } from 'zod'

// The order settings the api's /trade/order/place takes, mirroring
// apps/api/app/services/order_rules.py. The api decides which combinations
// moomoo accepts and answers a bad one with 422. The copy of those rules at
// the bottom of this file only hides fields the order ticket cannot use and
// stops an order that cannot be placed from being queued.

export const ORDER_TYPES = [
  'NORMAL', // limit
  'MARKET',
  'STOP', // stop-market
  'STOP_LIMIT',
  'MARKET_IF_TOUCHED',
  'LIMIT_IF_TOUCHED',
  'TRAILING_STOP',
  'TRAILING_STOP_LIMIT',
] as const
export const orderTypeSchema = z.enum(ORDER_TYPES)
export type OrderType = z.infer<typeof orderTypeSchema>

export const timeInForceSchema = z.enum(['DAY', 'GTC'])
export type TimeInForce = z.infer<typeof timeInForceSchema>

/** US stocks only. RTH = regular hours, ETH = pre/post market. */
export const sessionSchema = z.enum(['RTH', 'ETH', 'OVERNIGHT', 'ALL'])
export type OrderSession = z.infer<typeof sessionSchema>

/** RATIO is a percentage (5 = 5%); AMOUNT is a price distance. */
export const trailTypeSchema = z.enum(['RATIO', 'AMOUNT'])
export type TrailType = z.infer<typeof trailTypeSchema>

export const trdEnvSchema = z.enum(['SIMULATE', 'REAL'])
export type TrdEnv = z.infer<typeof trdEnvSchema>

/** Everything that decides what a new order does at the broker. */
export interface OrderSettings {
  code: string
  side: 'BUY' | 'SELL'
  qty: number
  price?: number
  order_type?: OrderType
  trigger_price?: number
  trail_type?: TrailType
  trail_value?: number
  trail_spread?: number
  time_in_force?: TimeInForce
  session?: OrderSession
}

/** What a modify can change. */
export interface OrderChange {
  order_id: string
  price?: number
  qty?: number
  trigger_price?: number
  trail_type?: TrailType
  trail_value?: number
  trail_spread?: number
}

// --- Rules (a copy of order_rules.py for the ticket and the queue) ---------

const LIMIT_PRICED: ReadonlySet<OrderType> = new Set(['NORMAL', 'STOP_LIMIT', 'LIMIT_IF_TOUCHED'])
const TRIGGERED: ReadonlySet<OrderType> = new Set(['STOP', 'STOP_LIMIT', 'MARKET_IF_TOUCHED', 'LIMIT_IF_TOUCHED'])
const TRAILING: ReadonlySet<OrderType> = new Set(['TRAILING_STOP', 'TRAILING_STOP_LIMIT'])
const PAPER_ORDER_TYPES: readonly OrderType[] = ['NORMAL', 'MARKET']
const SESSIONS: readonly OrderSession[] = sessionSchema.options

export interface OrderFields {
  /** The limit price. */
  price: boolean
  trigger: boolean
  /** trail_type and trail_value. */
  trail: boolean
  spread: boolean
}

export function orderFieldsFor(type: OrderType): OrderFields {
  return {
    price: LIMIT_PRICED.has(type),
    trigger: TRIGGERED.has(type),
    trail: TRAILING.has(type),
    spread: type === 'TRAILING_STOP_LIMIT',
  }
}

export function allowedOrderTypes(trdEnv: TrdEnv): OrderType[] {
  return trdEnv === 'SIMULATE' ? [...PAPER_ORDER_TYPES] : [...ORDER_TYPES]
}

export function allowedTimeInForce(trdEnv: TrdEnv): TimeInForce[] {
  return trdEnv === 'SIMULATE' ? ['DAY'] : ['DAY', 'GTC']
}

export function allowedSessions(args: { trdEnv: TrdEnv; orderType: OrderType; code: string }): OrderSession[] {
  if (!args.code.toUpperCase().startsWith('US.') || args.orderType === 'MARKET') return ['RTH']
  return SESSIONS.filter((s) => {
    if (s !== 'OVERNIGHT' && s !== 'ALL') return true
    return args.trdEnv === 'REAL' && args.orderType === 'NORMAL'
  })
}

export type OrderDraft = OrderSettings & { trd_env: TrdEnv }

/** The first rule the order breaks, in words, or null. */
export function orderRuleProblem(o: OrderDraft): string | null {
  const type = o.order_type ?? 'NORMAL'
  const tif = o.time_in_force ?? 'DAY'
  const session = o.session ?? 'RTH'
  const fields = orderFieldsFor(type)
  if (!Number.isInteger(o.qty) || o.qty < 1) return 'quantity must be a whole number of at least 1'
  if (fields.price && !(o.price != null && o.price > 0)) return `a limit price is required for ${type} orders`
  if (fields.trigger && !(o.trigger_price != null && o.trigger_price > 0)) return `a trigger price is required for ${type} orders`
  if (fields.trail) {
    if (!o.trail_type) return `a trail type (ratio or amount) is required for ${type} orders`
    if (!(o.trail_value != null && o.trail_value > 0)) return `a positive trail is required for ${type} orders`
    if (fields.spread && !(o.trail_spread != null && o.trail_spread >= 0)) return 'a trail spread is required for TRAILING_STOP_LIMIT orders'
  }
  if (o.trd_env === 'SIMULATE') {
    if (!PAPER_ORDER_TYPES.includes(type)) return `paper accounts take only limit and market orders, not ${type}`
    if (tif !== 'DAY') return 'paper accounts take DAY orders only'
    if (session === 'OVERNIGHT' || session === 'ALL') return `paper accounts have no overnight session (${session})`
  }
  if (session !== 'RTH' && !o.code.toUpperCase().startsWith('US.')) return `session ${session} applies to US stocks only`
  if (type === 'MARKET' && session !== 'RTH') return `market orders run in regular hours only, not ${session}`
  if ((session === 'OVERNIGHT' || session === 'ALL') && type !== 'NORMAL') return `session ${session} takes limit orders only, not ${type}`
  return null
}

/** The order with only the fields its type uses, so a field left over from another type is never sent. */
export function pickOrderFields(o: OrderSettings): OrderSettings {
  const type = o.order_type ?? 'NORMAL'
  const fields = orderFieldsFor(type)
  const out: OrderSettings = { code: o.code, side: o.side, qty: o.qty, order_type: type }
  if (fields.price && o.price != null) out.price = o.price
  if (fields.trigger && o.trigger_price != null) out.trigger_price = o.trigger_price
  if (fields.trail) {
    if (o.trail_type) out.trail_type = o.trail_type
    if (o.trail_value != null) out.trail_value = o.trail_value
  }
  if (fields.spread && o.trail_spread != null) out.trail_spread = o.trail_spread
  if (o.time_in_force) out.time_in_force = o.time_in_force
  if (o.session) out.session = o.session
  return out
}

/**
 * How long a proposal must sit in submitting before it can be resolved by
 * hand. Longer than one whole approval (account lookup, the 120 s order call,
 * the remark lookup), so an approval still in flight is never second-guessed.
 */
export const STUCK_AFTER_MS = 5 * 60_000
